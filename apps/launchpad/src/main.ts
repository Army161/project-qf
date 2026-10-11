// CLI for the launchpad. One setting picks the engine (ADR-014):
//   QF_ENGINE=qf        Project QF's own engine (engine/main.ts): qf-curve, graduating into qf-pool, quoted in SOL
//   QF_ENGINE=meteora   the Meteora devnet launchpad (meteora-main.ts); also when QF_ENGINE is unset
// Meteora stays the default until the engine's own devnet proof run passes; then the default flips and Meteora is removed.
// Each engine keeps its own database, so the two never mix. Commands and settings: see each file's header.
const engine = process.env.QF_ENGINE || 'meteora';
if (engine === 'qf') await import('./engine/main.ts');
else if (engine === 'meteora') await import('./meteora-main.ts');
else { console.error(`QF_ENGINE must be 'qf' or 'meteora' (got '${engine}')`); process.exitCode = 64; }
