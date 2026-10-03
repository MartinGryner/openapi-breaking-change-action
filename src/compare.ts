import { parse as parseYaml } from "yaml";

export type ChangeSeverity = "breaking" | "review" | "compatible";
export type ApiChange = {
  severity: ChangeSeverity;
  scope: string;
  path: string;
  message: string;
  explanation: string;
};

export type ApiComparison = {
  oldVersion: string;
  newVersion: string;
  changes: ApiChange[];
  counts: Record<ChangeSeverity, number>;
  warnings: string[];
};

type JsonObject = Record<string, any>;
const httpMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function parseApiSpec(source: string): JsonObject {
  if (!source.trim()) throw new Error("The specification is empty.");
  const parsed = parseYaml(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The specification must be a JSON or YAML object.");
  const version = parsed.openapi ?? parsed.swagger;
  if (typeof version !== "string" || (!version.startsWith("3.") && version !== "2.0")) {
    throw new Error("Expected Swagger 2.0 or OpenAPI 3.0/3.1.");
  }
  if (!parsed.paths || typeof parsed.paths !== "object" || Array.isArray(parsed.paths)) throw new Error("The specification has no paths object.");
  return parsed;
}

function specVersion(spec: JsonObject) {
  return spec.openapi ? `OpenAPI ${spec.openapi}` : `Swagger ${spec.swagger}`;
}

function push(changes: ApiChange[], severity: ChangeSeverity, scope: string, path: string, message: string, explanation: string) {
  changes.push({ severity, scope, path, message, explanation });
}

function decodePointerPart(value: string) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveRef(spec: JsonObject, value: any, warnings: Set<string>, stack = new Set<string>()): any {
  if (!value || typeof value !== "object" || typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) {
    warnings.add(`External reference not resolved: ${ref}`);
    return value;
  }
  if (stack.has(ref)) return value;
  let current: any = spec;
  for (const part of ref.slice(2).split("/").map(decodePointerPart)) current = current?.[part];
  if (!current) {
    warnings.add(`Internal reference not found: ${ref}`);
    return value;
  }
  return resolveRef(spec, current, warnings, new Set([...stack, ref]));
}

function schemaType(spec: JsonObject, schema: any, warnings: Set<string>) {
  const resolved = resolveRef(spec, schema, warnings);
  if (!resolved || typeof resolved !== "object") return "unknown";
  if (Array.isArray(resolved.type)) return resolved.type.join(" | ");
  if (resolved.type) return String(resolved.type);
  if (resolved.properties) return "object";
  if (resolved.items) return "array";
  return "unknown";
}

function parameterSchema(spec: JsonObject, parameter: any, warnings: Set<string>) {
  const resolved = resolveRef(spec, parameter, warnings);
  return resolved?.schema ?? resolved;
}

function parameterMap(spec: JsonObject, pathItem: any, operation: any, warnings: Set<string>) {
  const map = new Map<string, any>();
  for (const parameter of [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])]) {
    const resolved = resolveRef(spec, parameter, warnings);
    if (!resolved?.name || !resolved?.in) continue;
    if (resolved.in === "body") continue;
    map.set(`${resolved.in}:${resolved.name}`, resolved);
  }
  return map;
}

function requestBodies(spec: JsonObject, operation: any, warnings: Set<string>) {
  if (spec.swagger === "2.0") {
    const body = (operation?.parameters ?? []).map((parameter: any) => resolveRef(spec, parameter, warnings)).find((parameter: any) => parameter?.in === "body");
    if (!body) return {};
    const mediaTypes = operation.consumes ?? spec.consumes ?? ["application/json"];
    return Object.fromEntries(mediaTypes.map((media: string) => [media, { schema: body.schema, required: Boolean(body.required) }]));
  }
  const body = resolveRef(spec, operation?.requestBody, warnings);
  return Object.fromEntries(Object.entries(body?.content ?? {}).map(([media, entry]: [string, any]) => [media, { ...entry, required: Boolean(body?.required) }]));
}

function responseContent(spec: JsonObject, response: any, operation: any, warnings: Set<string>) {
  const resolved = resolveRef(spec, response, warnings);
  if (spec.swagger === "2.0") {
    const mediaTypes = operation.produces ?? spec.produces ?? ["application/json"];
    return Object.fromEntries(mediaTypes.map((media: string) => [media, { schema: resolved?.schema }]));
  }
  return resolved?.content ?? {};
}

function compareSchema(
  oldSpec: JsonObject,
  newSpec: JsonObject,
  oldSchema: any,
  newSchema: any,
  location: string,
  direction: "request" | "response",
  changes: ApiChange[],
  warnings: Set<string>,
  depth = 0,
) {
  if (depth > 8) {
    warnings.add(`Schema comparison depth limit reached at ${location}`);
    return;
  }
  const oldResolved = resolveRef(oldSpec, oldSchema, warnings);
  const newResolved = resolveRef(newSpec, newSchema, warnings);
  if (!oldResolved || !newResolved) return;
  const oldType = schemaType(oldSpec, oldResolved, warnings);
  const newType = schemaType(newSpec, newResolved, warnings);
  if (oldType !== newType) {
    push(changes, "breaking", "Schema", location, `Type changed from ${oldType} to ${newType}`, "Existing clients may serialize, validate, or read this value using the previous type.");
    return;
  }
  if (oldType === "array") {
    compareSchema(oldSpec, newSpec, oldResolved.items, newResolved.items, `${location}[]`, direction, changes, warnings, depth + 1);
  }

  const oldEnum = new Set(Array.isArray(oldResolved.enum) ? oldResolved.enum.map(String) : []);
  const newEnum = new Set(Array.isArray(newResolved.enum) ? newResolved.enum.map(String) : []);
  const removedEnum = [...oldEnum].filter((value) => !newEnum.has(value));
  const addedEnum = [...newEnum].filter((value) => !oldEnum.has(value));
  if (removedEnum.length && direction === "request") push(changes, "breaking", "Schema", location, `Accepted enum values removed: ${removedEnum.join(", ")}`, "A client using one of these request values may now be rejected.");
  else if (removedEnum.length) push(changes, "compatible", "Schema", location, `Response enum values no longer produced: ${removedEnum.join(", ")}`, "Returning fewer previously documented values is normally safe for consumers.");
  if (addedEnum.length && direction === "response") push(changes, "review", "Schema", location, `Response enum values added: ${addedEnum.join(", ")}`, "Strict clients may not handle newly returned enum values even though the schema was widened.");
  else if (addedEnum.length) push(changes, "compatible", "Schema", location, `Accepted enum values added: ${addedEnum.join(", ")}`, "The API accepts more request values than before.");

  const oldProperties = oldResolved.properties ?? {};
  const newProperties = newResolved.properties ?? {};
  const oldRequired = new Set<string>(oldResolved.required ?? []);
  const newRequired = new Set<string>(newResolved.required ?? []);
  for (const property of Object.keys(oldProperties)) {
    const propertyPath = `${location}.${property}`;
    if (!(property in newProperties)) {
      push(changes, direction === "response" ? "breaking" : "review", "Schema", propertyPath, "Property removed", direction === "response" ? "Existing clients may read this documented response property." : "A request field is no longer documented; verify whether the server still tolerates it.");
      continue;
    }
    if (!oldRequired.has(property) && newRequired.has(property)) {
      push(changes, direction === "request" ? "breaking" : "compatible", "Schema", propertyPath, "Property became required", direction === "request" ? "Existing clients may omit this request property." : "The response now makes a stronger presence guarantee.");
    }
    if (oldRequired.has(property) && !newRequired.has(property) && direction === "response") {
      push(changes, "breaking", "Schema", propertyPath, "Response property is no longer required", "Clients can no longer rely on this property being present.");
    }
    compareSchema(oldSpec, newSpec, oldProperties[property], newProperties[property], propertyPath, direction, changes, warnings, depth + 1);
  }
  for (const property of Object.keys(newProperties)) {
    if (property in oldProperties) continue;
    const required = newRequired.has(property);
    if (direction === "request" && required) push(changes, "breaking", "Schema", `${location}.${property}`, "Required request property added", "Existing clients do not send this newly required property.");
    else push(changes, "compatible", "Schema", `${location}.${property}`, `${required ? "Required" : "Optional"} ${direction} property added`, direction === "response" ? "Clients that ignore unknown response properties should continue to work." : "Existing request bodies remain valid because the new field is optional.");
  }
}

function compareOperation(oldSpec: JsonObject, newSpec: JsonObject, apiPath: string, method: string, oldPath: any, newPath: any, oldOperation: any, newOperation: any, changes: ApiChange[], warnings: Set<string>) {
  const label = `${method.toUpperCase()} ${apiPath}`;
  const oldParameters = parameterMap(oldSpec, oldPath, oldOperation, warnings);
  const newParameters = parameterMap(newSpec, newPath, newOperation, warnings);
  for (const [key, parameter] of oldParameters) {
    if (!newParameters.has(key)) push(changes, "review", "Parameter", `${label} · ${key}`, "Parameter removed", "Verify whether the server still accepts clients that send this previously documented parameter.");
    else {
      const next = newParameters.get(key);
      if (!parameter.required && next.required) push(changes, "breaking", "Parameter", `${label} · ${key}`, "Parameter became required", "Existing clients may omit this parameter.");
      const oldType = schemaType(oldSpec, parameterSchema(oldSpec, parameter, warnings), warnings);
      const newType = schemaType(newSpec, parameterSchema(newSpec, next, warnings), warnings);
      if (oldType !== newType) push(changes, "breaking", "Parameter", `${label} · ${key}`, `Parameter type changed from ${oldType} to ${newType}`, "Existing clients may encode this parameter using the previous type.");
    }
  }
  for (const [key, parameter] of newParameters) {
    if (oldParameters.has(key)) continue;
    push(changes, parameter.required ? "breaking" : "compatible", "Parameter", `${label} · ${key}`, `${parameter.required ? "Required" : "Optional"} parameter added`, parameter.required ? "Existing clients do not provide this newly required parameter." : "Existing requests remain valid because the new parameter is optional.");
  }

  const oldBodies = requestBodies(oldSpec, oldOperation, warnings);
  const newBodies = requestBodies(newSpec, newOperation, warnings);
  const oldBodyMedia = Object.keys(oldBodies);
  const newBodyEntries = Object.entries(newBodies) as [string, any][];
  if (oldBodyMedia.length === 0 && newBodyEntries.some(([, entry]) => entry.required)) {
    push(changes, "breaking", "Request body", label, "Required request body added", "Existing clients may call this operation without a body.");
  }
  for (const [media, entry] of Object.entries(oldBodies) as [string, any][]) {
    const next = newBodies[media];
    if (!next) push(changes, "breaking", "Request body", `${label} · ${media}`, "Request media type removed", "Clients using this content type may now be rejected.");
    else {
      if (!entry.required && next.required) push(changes, "breaking", "Request body", label, "Request body became required", "Existing clients may call this operation without a body.");
      compareSchema(oldSpec, newSpec, entry.schema, next.schema, `${label} request`, "request", changes, warnings);
    }
  }
  for (const [media, entry] of newBodyEntries) {
    if (media in oldBodies) continue;
    if (oldBodyMedia.length === 0 && entry.required) continue;
    push(changes, "compatible", "Request body", `${label} · ${media}`, oldBodyMedia.length === 0 ? "Optional request body added" : "Request media type added", oldBodyMedia.length === 0 ? "Existing calls remain valid because the new request body is optional." : "The operation accepts an additional request representation.");
  }

  const oldResponses = oldOperation.responses ?? {};
  const newResponses = newOperation.responses ?? {};
  for (const [status, response] of Object.entries(oldResponses)) {
    if (!(status in newResponses)) {
      push(changes, "breaking", "Response", `${label} · ${status}`, "Response removed", "Clients may rely on this documented response status and payload.");
      continue;
    }
    const oldContent = responseContent(oldSpec, response, oldOperation, warnings);
    const newContent = responseContent(newSpec, newResponses[status], newOperation, warnings);
    for (const [media, entry] of Object.entries(oldContent) as [string, any][]) {
      if (!(media in newContent)) push(changes, "breaking", "Response", `${label} · ${status} · ${media}`, "Response media type removed", "Clients requesting this representation may no longer receive it.");
      else compareSchema(oldSpec, newSpec, entry?.schema, newContent[media]?.schema, `${label} response ${status}`, "response", changes, warnings);
    }
  }
  for (const status of Object.keys(newResponses)) if (!(status in oldResponses)) push(changes, "compatible", "Response", `${label} · ${status}`, "Response added", "The operation documents an additional response outcome.");

  const oldSecurity = oldOperation.security ?? oldSpec.security ?? [];
  const newSecurity = newOperation.security ?? newSpec.security ?? [];
  if (JSON.stringify(oldSecurity) !== JSON.stringify(newSecurity)) {
    const tightened = oldSecurity.length === 0 && newSecurity.length > 0;
    push(changes, tightened ? "breaking" : "review", "Security", label, tightened ? "Authentication requirement added" : "Security requirements changed", tightened ? "Previously unauthenticated clients now need credentials." : "Review authorization scopes and alternatives manually; equivalent security expressions can differ structurally.");
  }
}

export function compareApiSpecs(oldSpec: JsonObject, newSpec: JsonObject): ApiComparison {
  const changes: ApiChange[] = [];
  const warnings = new Set<string>();
  const oldPaths = oldSpec.paths ?? {};
  const newPaths = newSpec.paths ?? {};
  for (const [apiPath, oldPath] of Object.entries(oldPaths) as [string, any][]) {
    if (!(apiPath in newPaths)) {
      push(changes, "breaking", "Path", apiPath, "Path removed", "Every operation under this path is no longer documented for clients.");
      continue;
    }
    const newPath = newPaths[apiPath];
    for (const method of httpMethods) {
      if (!oldPath?.[method]) continue;
      if (!newPath?.[method]) push(changes, "breaking", "Operation", `${method.toUpperCase()} ${apiPath}`, "Operation removed", "Existing clients can no longer rely on this method and path.");
      else compareOperation(oldSpec, newSpec, apiPath, method, oldPath, newPath, oldPath[method], newPath[method], changes, warnings);
    }
  }
  for (const [apiPath, newPath] of Object.entries(newPaths) as [string, any][]) {
    if (!(apiPath in oldPaths)) {
      push(changes, "compatible", "Path", apiPath, "Path added", "Existing client behavior is unchanged.");
      continue;
    }
    for (const method of httpMethods) if (newPath?.[method] && !oldPaths[apiPath]?.[method]) push(changes, "compatible", "Operation", `${method.toUpperCase()} ${apiPath}`, "Operation added", "Existing client behavior is unchanged.");
  }
  const counts = { breaking: 0, review: 0, compatible: 0 };
  for (const change of changes) counts[change.severity] += 1;
  return { oldVersion: specVersion(oldSpec), newVersion: specVersion(newSpec), changes, counts, warnings: [...warnings] };
}

export function comparisonToMarkdown(result: ApiComparison) {
  const lines = ["# OpenAPI compatibility report", "", `- Baseline: ${result.oldVersion}`, `- Candidate: ${result.newVersion}`, `- Breaking: ${result.counts.breaking}`, `- Review: ${result.counts.review}`, `- Compatible: ${result.counts.compatible}`, ""];
  for (const severity of ["breaking", "review", "compatible"] as const) {
    lines.push(`## ${severity === "review" ? "Needs review" : severity[0].toUpperCase() + severity.slice(1)}`, "");
    const entries = result.changes.filter((change) => change.severity === severity);
    if (!entries.length) lines.push("None.", "");
    for (const change of entries) lines.push(`- **${change.message}** — \`${change.path}\``, `  ${change.explanation}`, "");
  }
  if (result.warnings.length) lines.push("## Warnings", "", ...result.warnings.map((warning) => `- ${warning}`), "");
  lines.push("_Heuristic report generated locally. Review important API changes against your implementation and client contracts._", "");
  return lines.join("\n");
}

export const baselineExample = `openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
paths:
  /orders/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: An order
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
components:
  schemas:
    Order:
      type: object
      required: [id, status, total]
      properties:
        id: { type: string }
        status: { type: string, enum: [pending, paid] }
        total: { type: number }
`;

export const candidateExample = `openapi: 3.1.0
info:
  title: Orders API
  version: 2.0.0
paths:
  /orders/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
        - name: locale
          in: query
          required: true
          schema: { type: string }
      responses:
        "200":
          description: An order
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
  /orders:
    post:
      responses:
        "201": { description: Created }
components:
  schemas:
    Order:
      type: object
      required: [id, status]
      properties:
        id: { type: string }
        status: { type: string, enum: [pending, paid, refunded] }
        currency: { type: string }
`;
