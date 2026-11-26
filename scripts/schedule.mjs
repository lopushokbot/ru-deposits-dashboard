// Weekly schedule: the job is due once per week, from Thursday 08:30 Dubai (UTC+4, no DST).
// launchd also fires hourly, so a Mac that slept through Thursday morning catches up at the next tick.
//   node scripts/schedule.mjs check        → prints "update", "send" or "none"
//   node scripts/schedule.mjs mark update  → records a successful update (publish)
//   node scripts/schedule.mjs mark send    → records a delivered Telegram digest
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const STATE = path.join(ROOT, "logs/state.json");
const read = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const DUBAI = 4 * 3600e3, WEEKDAY = 4, HOUR = 8, MIN = 30; // Thursday 08:30

/** Most recent Thursday 08:30 Dubai at or before now (epoch ms). */
export function lastSlot(now = Date.now()) {
  const local = new Date(now + DUBAI); // read UTC fields as Dubai wall time
  const slot = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), HOUR, MIN));
  let back = (local.getUTCDay() - WEEKDAY + 7) % 7;
  if (back === 0 && local < slot) back = 7;
  return slot.getTime() - back * 864e5 - DUBAI;
}

const [cmd, what] = process.argv.slice(2);
const s = read(), slot = lastSlot();
if (import.meta.url !== `file://${process.argv[1]}`) { /* imported as a module */ }
else if (cmd === "check") {
  if (!(Date.parse(s.lastUpdate || 0) >= slot)) console.log("update");
  else if (!(Date.parse(s.lastSent || 0) >= slot)) console.log("send");
  else console.log("none");
} else if (cmd === "mark" && (what === "update" || what === "send")) {
  s[what === "update" ? "lastUpdate" : "lastSent"] = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + "\n");
} else if (cmd === "slot") {
  console.log(new Date(slot).toISOString());
} else {
  console.error("usage: schedule.mjs check | mark update|send | slot");
  process.exit(2);
}
