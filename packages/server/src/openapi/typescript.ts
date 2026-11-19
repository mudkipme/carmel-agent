type Schema = {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  nullable?: boolean;
  default?: unknown;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  description?: string;
  "x-typescript-type"?: string;
};
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema };
type Content = Record<string, { schema?: Schema }>;
type Operation = {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { content?: Content };
  responses: Record<string, { content?: Content }>;
};
type Document = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

/**
 * Requests may omit a property with a default; responses always carry it.
 * Request bodies therefore reference `ApiInputSchemas`, responses `ApiSchemas`.
 */
type Mode = "input" | "output";

const identifier = /^[A-Za-z_$][\w$]*$/;
const modules: Record<string, string> = { Shared: "./index.ts", Pi: "./pi.ts" };
const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name));
/** `{ nullable: true }` alone: how OpenAPI 3.0 adds null to a referenced schema. */
const onlyNullable = (schema: Schema) =>
  schema.nullable === true && Object.keys(schema).length === 1;
const group = (type: string) => (/[|&]/.test(type) && !type.startsWith("{") ? `(${type})` : type);

class Emitter {
  readonly namespaces = new Set<string>();
  readonly inputs = new Set<string>();

  constructor(private readonly schemas: Record<string, Schema>) {}

  type(schema: Schema | undefined, mode: Mode, indent = ""): string {
    if (!schema) return "unknown";
    const nullable = (type: string) => (schema.nullable ? `${type} | null` : type);
    const named = schema["x-typescript-type"];
    if (named) {
      this.namespaces.add(named.split(".")[0]!);
      return nullable(named);
    }
    if (schema.$ref) {
      const name = schema.$ref.split("/").pop()!;
      if (mode === "input" && !this.inputs.has(name)) {
        this.inputs.add(name);
        this.type(this.schemas[name], "input");
      }
      const table = mode === "input" ? "ApiInputSchemas" : "ApiSchemas";
      return nullable(`${table}[${JSON.stringify(name)}]`);
    }
    if (schema.allOf) {
      const parts = schema.allOf.filter((part) => !onlyNullable(part));
      const type = parts.map((part) => group(this.type(part, mode, indent))).join(" & ");
      return parts.length < schema.allOf.length ? `${type} | null` : nullable(type);
    }
    const union = schema.anyOf ?? schema.oneOf;
    if (union)
      return nullable(
        union
          .map((part) => (onlyNullable(part) ? "null" : group(this.type(part, mode, indent))))
          .join(" | "),
      );
    if (schema.enum) return nullable(schema.enum.map((value) => JSON.stringify(value)).join(" | "));
    switch (schema.type) {
      case "string":
        return nullable("string");
      case "integer":
      case "number":
        return nullable("number");
      case "boolean":
        return nullable("boolean");
      case "array":
        return nullable(`Array<${this.type(schema.items, mode, indent)}>`);
    }
    if (schema.type === "object" || schema.properties) {
      const inner = `${indent}  `;
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(([name, property]) => {
        const present = required.has(name) || (mode === "output" && property.default !== undefined);
        return `${inner}${key(name)}${present ? "" : "?"}: ${this.type(property, mode, inner)};`;
      });
      const extra = schema.additionalProperties;
      if (extra && typeof extra === "object") {
        const value = this.type(extra, mode, inner);
        if (!fields.length) return nullable(`Record<string, ${value}>`);
        fields.push(`${inner}[key: string]: unknown;`);
      } else if (!fields.length) return nullable("Record<string, unknown>");
      return nullable(`{\n${fields.join("\n")}\n${indent}}`);
    }
    return "unknown";
  }

  parameters(list: Parameter[], location: string, indent: string) {
    const fields = list
      .filter((parameter) => parameter.in === location)
      .map(
        (parameter) =>
          `${indent}  ${key(parameter.name)}${parameter.required ? "" : "?"}: ${this.type(parameter.schema, "input", `${indent}  `)};`,
      );
    return fields.length ? `{\n${fields.join("\n")}\n${indent}}` : "never";
  }

  content(content: Content | undefined, mode: Mode, indent: string) {
    if (!content) return undefined;
    const json = content["application/json"];
    return json ? this.type(json.schema, mode, indent) : "Blob";
  }
}

/** TypeScript types and a route table for every operation, for typed clients. */
export function renderApiTypes(input: object) {
  const document = input as Document;
  const schemas = document.components?.schemas ?? {};
  const emit = new Emitter(schemas);
  const routes: string[] = [];
  const operations: string[] = [];
  for (const [path, item] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(item)) {
      const id = operation.operationId;
      const indent = "    ";
      const parameters = operation.parameters ?? [];
      const success = Object.entries(operation.responses)
        .filter(([status]) => status.startsWith("2"))
        .map(([, response]) => emit.content(response.content, "output", indent) ?? "void");
      routes.push(
        `  ${id}: { method: ${JSON.stringify(method.toUpperCase())}, path: ${JSON.stringify(path)} },`,
      );
      operations.push(
        [
          `  ${id}: {`,
          `    path: ${emit.parameters(parameters, "path", indent)};`,
          `    query: ${emit.parameters(parameters, "query", indent)};`,
          `    body: ${emit.content(operation.requestBody?.content, "input", indent) ?? "never"};`,
          `    response: ${[...new Set(success)].join(" | ") || "void"};`,
          `  };`,
        ].join("\n"),
      );
    }
  const outputs = Object.entries(schemas)
    .map(([name, schema]) => `  ${key(name)}: ${emit.type(schema, "output", "  ")};`)
    .join("\n");
  const inputs = [...emit.inputs]
    .sort()
    .map((name) => `  ${key(name)}: ${emit.type(schemas[name], "input", "  ")};`)
    .join("\n");
  const imports = [...emit.namespaces]
    .sort()
    .map((name) => `import type * as ${name} from ${JSON.stringify(modules[name])};\n`)
    .join("");
  return `// Generated by \`pnpm openapi\` from the server's route definitions. Do not edit.
${imports ? `\n${imports}` : ""}
export interface ApiSchemas {
${outputs}
}

export interface ApiInputSchemas {
${inputs}
}

export interface ApiOperations {
${operations.join("\n")}
}

export const apiRoutes = {
${routes.join("\n")}
} as const satisfies Record<keyof ApiOperations, { method: string; path: string }>;
`;
}
