// Diagnostic: prove the role distribution for every supported player count.
// Pure-engine only (no network, no state). Verifies a detective always exists.
const L = require("../core/logic");

let bad = 0;
for (let n = 5; n <= 12; n++) {
  const counts = L.roleCountsFor(n);
  // Sanity: every count must have exactly 1 detective and 1 doctor.
  if (counts.detective !== 1) { console.log(`  BAD roleCountsFor(${n}).detective=${counts.detective}`); bad++; }
  if (counts.doctor !== 1) { console.log(`  BAD roleCountsFor(${n}).doctor=${counts.doctor}`); bad++; }
  // Deal 1000 random games at this size; assert a detective is always dealt.
  let noDet = 0;
  for (let i = 0; i < 1000; i++) {
    const ids = Array.from({ length: n }, (_, k) => "p" + k);
    const m = L.assignRoles(ids);
    const dist = {};
    Object.values(m).forEach((r) => (dist[r] = (dist[r] || 0) + 1));
    if ((dist.detective || 0) !== 1) noDet++;
  }
  console.log(`  n=${n}: counts=${JSON.stringify(counts)} | deals missing detective: ${noDet}/1000`);
  if (noDet > 0) bad++;
}
console.log(bad === 0 ? "\nENGINE ROLE DISTRIBUTION OK — detective always dealt." : `\nFAIL: ${bad} problems`);
process.exit(bad ? 1 : 0);
