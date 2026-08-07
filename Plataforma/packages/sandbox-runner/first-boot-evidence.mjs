import { runIsolatedBoot } from '@voidfall/sandbox-runner';

const workspaceRoot = process.argv[2];
const started = Date.now();
try {
  const evidence = await runIsolatedBoot({
    workspaceRoot,
    timeoutMs: 480_000,
    onProgress: (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`),
  });
  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify({
    java: evidence.java,
    argsFile: evidence.argsFile,
    filesCopied: evidence.filesCopied,
    mib: Math.round(evidence.bytesCopied / 1048576),
    outcome: evidence.report.outcome,
    durationMs: evidence.report.durationMs,
    generatedFiles: evidence.report.generatedFiles.length,
  }, null, 2));
  console.log('\n=== TAIL ===');
  for (const line of evidence.report.tail) console.log(line);
} catch (error) {
  console.log('BLOCKED:', error?.code ?? error?.name, error?.path ?? '', error?.message ?? '');
  process.exitCode = 1;
}
