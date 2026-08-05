import { mkdir, writeFile } from 'node:fs/promises';
import { AgentEnvelopeSchema } from './agent-envelope.js';
import {
  ArtifactCompatibilityPlanSchema,
  ArtifactCompatibilityReportSchema,
} from './artifact-compatibility.js';
import { ArtifactInspectionReportSchema } from './artifact-inspection.js';
import { AuditChainExportManifestSchema } from './audit-chain-export.js';
import { AuditEventSchema } from './audit-event.js';
import { CatalogReconciliationReportSchema } from './catalog-reconciliation.js';
import { ForgeBuildRequestSchema } from './forge-build-request.js';
import { InventorySnapshotSchema } from './inventory-snapshot.js';
import { JobSchema } from './job.js';
import { LauncherChannelSchema } from './launcher-channel.js';
import { LauncherManagedStateSchema } from './launcher-state.js';
import { MinecraftPermissionBindingSchema } from './minecraft-permission-binding.js';
import { ModCatalogEntrySchema } from './mod-catalog-entry.js';
import {
  ModCompatibilityAnalysisPlanSchema,
  ModCompatibilityReportSchema,
} from './mod-compatibility.js';
import { ModerationCaseSchema } from './moderation-case.js';
import { PlayerDataPolicySchema } from './player-data-policy.js';
import { PlayerProfileSchema } from './player-profile.js';
import { ReleaseManifestSchema } from './release-manifest.js';
import {
  ConfigurationApplyRequestSchema,
  ConfigurationOperationAcceptanceSchema,
  ConfigurationOperationCommandSchema,
  ConfigurationOperationResultSchema,
  ConfigurationResourceStateSchema,
  ConfigurationRevisionPageSchema,
  ConfigurationRollbackRequestSchema,
  ConfigurationSchemaCatalogSchema,
  ConfigurationValidationRequestSchema,
  ConfigurationValidationResultSchema,
} from './server-configuration.js';

const schemas = [
  ['agent-envelope.schema.json', AgentEnvelopeSchema],
  ['artifact-compatibility-plan.schema.json', ArtifactCompatibilityPlanSchema],
  ['artifact-compatibility-report.schema.json', ArtifactCompatibilityReportSchema],
  ['artifact-inspection-report.schema.json', ArtifactInspectionReportSchema],
  ['audit-chain-export-manifest.schema.json', AuditChainExportManifestSchema],
  ['audit-event.schema.json', AuditEventSchema],
  ['catalog-reconciliation-report.schema.json', CatalogReconciliationReportSchema],
  ['configuration-apply-request.schema.json', ConfigurationApplyRequestSchema],
  ['configuration-operation-acceptance.schema.json', ConfigurationOperationAcceptanceSchema],
  ['configuration-operation-command.schema.json', ConfigurationOperationCommandSchema],
  ['configuration-operation-result.schema.json', ConfigurationOperationResultSchema],
  ['configuration-resource-state.schema.json', ConfigurationResourceStateSchema],
  ['configuration-revision-page.schema.json', ConfigurationRevisionPageSchema],
  ['configuration-rollback-request.schema.json', ConfigurationRollbackRequestSchema],
  ['configuration-schema-catalog.schema.json', ConfigurationSchemaCatalogSchema],
  ['configuration-validation-request.schema.json', ConfigurationValidationRequestSchema],
  ['configuration-validation-result.schema.json', ConfigurationValidationResultSchema],
  ['forge-build-request.schema.json', ForgeBuildRequestSchema],
  ['inventory-snapshot.schema.json', InventorySnapshotSchema],
  ['job.schema.json', JobSchema],
  ['launcher-channel.schema.json', LauncherChannelSchema],
  ['launcher-managed-state.schema.json', LauncherManagedStateSchema],
  ['minecraft-permission-binding.schema.json', MinecraftPermissionBindingSchema],
  ['mod-catalog-entry.schema.json', ModCatalogEntrySchema],
  ['mod-compatibility-analysis-plan.schema.json', ModCompatibilityAnalysisPlanSchema],
  ['mod-compatibility-report.schema.json', ModCompatibilityReportSchema],
  ['moderation-case.schema.json', ModerationCaseSchema],
  ['player-data-policy.schema.json', PlayerDataPolicySchema],
  ['player-profile.schema.json', PlayerProfileSchema],
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
