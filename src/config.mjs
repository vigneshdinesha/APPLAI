import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config();

export const TZ = process.env.TZ || "America/New_York";
export const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || "10", 10);
export const PROFILE_JSON = process.env.PROFILE_JSON || "./profile.json";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

export function loadProfile() {
  const p = path.resolve(PROFILE_JSON);
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  return data;
}

export function loadApplied() {
  const p = path.resolve("./applied.json");
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveApplied(obj) {
  fs.writeFileSync("./applied.json", JSON.stringify(obj, null, 2));
}
