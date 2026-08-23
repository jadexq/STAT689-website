// Loads .env, and must be the FIRST import of the process.
//
// It used to be a dotenv.config() call partway down index.ts. That reads
// correctly, but ES imports are hoisted: every module imported below it had
// already been evaluated, so anything reading process.env at module scope —
// identity.ts, roster.ts, paths.ts — saw an empty environment and silently
// took its defaults. The symptom was a roster that reported zero assigned
// students while .env plainly assigned one.
//
// Nothing in the cloud depended on this (Cloud Run sets real environment
// variables), which is exactly why it could sit here unnoticed: it only ever
// broke local development, where it looks like your config is being ignored.

import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });
