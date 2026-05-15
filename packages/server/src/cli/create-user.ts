import { eq } from "drizzle-orm";
import { db, migrate, seed } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { hashPassword } from "../auth.ts";

type Args = {
  id?: string;
  username?: string;
  password?: string;
  name?: string;
  email?: string;
};

async function main() {
  const args = readArgs(process.argv.slice(2));
  const username = args.username?.trim();
  const password = args.password ?? process.env.CARMEL_PASSWORD;
  if (!username) throw new Error("Missing --username.");
  if (!password) throw new Error("Missing --password or CARMEL_PASSWORD.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  migrate();
  seed();

  const timestamp = now();
  const existingByUsername = db.select().from(users).where(eq(users.username, username)).get();
  const allUsers = db.select().from(users).all();
  const reusableDefaultUser = allUsers.length === 1 && !allUsers[0].username ? allUsers[0] : undefined;
  const userId = args.id ?? existingByUsername?.id ?? reusableDefaultUser?.id ?? id("user");
  const current = existingByUsername ?? reusableDefaultUser;
  const passwordHash = await hashPassword(password);

  db.insert(users)
    .values({
      id: userId,
      username,
      passwordHash,
      name: args.name ?? current?.name ?? username,
      email: args.email ?? current?.email ?? `${username}@local`,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        username,
        passwordHash,
        name: args.name ?? current?.name ?? username,
        email: args.email ?? current?.email ?? `${username}@local`,
        updatedAt: timestamp,
      },
    })
    .run();

  console.log(`User ${username} is ready.`);
}

function readArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) continue;
    index += 1;
    if (key === "id" || key === "username" || key === "password" || key === "name" || key === "email") {
      args[key] = value;
    }
  }
  return args;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
