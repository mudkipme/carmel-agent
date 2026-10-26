import { initialize, sqlite } from "../db/index.ts";

try {
  initialize();
  console.log("Database migrations applied.");
} finally {
  sqlite.close();
}
