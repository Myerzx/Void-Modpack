import { mkdir, writeFile } from 'node:fs/promises';
import { AgentEnvelopeSchema } from './agent-envelope.js';
import { AuditEventSchema } from './audit-event.js';
import { CatalogReconciliationReportSchema } from './catalog-reconciliation.js';
import { InventorySnapshotSchema } from './inventory-snapshot.js';
import { JobSchema } from './job.js';
import { ModCatalogEntrySchema } from './mod-catalog-entry.js';
import { ReleaseManifestSchema } from './release-manifest.js';

const schemas = [
  ['agent-envelope.schema.json', AgentEnvelopeSchema],
  ['audit-event.schema.json', AuditEventSchema],
  ['catalog-reconciliation-report.schema.json', CatalogReconciliationReportSchema],
  ['inventory-snapshot.schema.json', InventorySnapshotSchema],
  ['job.schema.json', JobSchema],
  ['mod-catalog-entry.schema.json', ModCatalogEntrySchema],
  ['release-manifest.schema.json', ReleaseManifestSchema],
] as const;

const schemaDirectory = new URL('./schemas/', import.meta.url);
await mkdir(schemaDirectory, { recursive: true });

await Promise.all(
  schemas.map(async ([filename, schema]) => {
    const output = `${JSON.stringify(schema, null, 2)}\n`;
    await writeFile(new URL(filename, schemaDirectory), output, 'utf8');
  }),
);
