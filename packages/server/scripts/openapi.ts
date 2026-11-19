import { writeFileSync } from "node:fs";
import { createApiDocument, renderApiDocument } from "../src/openapi/document.ts";
import { renderApiTypes } from "../src/openapi/typescript.ts";

writeFileSync(new URL("../../shared/openapi.yaml", import.meta.url), renderApiDocument());
writeFileSync(
  new URL("../../shared/src/api.ts", import.meta.url),
  renderApiTypes(createApiDocument()),
);
