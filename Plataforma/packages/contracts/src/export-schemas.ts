import { mkdir, writeFile } from 'node:fs/promises';
import { AgentEnvelopeSchema } from './agent-envelope.js';
import {
  AgentCredentialSchema,
  AgentWorkClaimResponseSchema,
  AgentWorkLeaseSchema,
} from './agent-transport.js';
import {
  ArtifactCompatibilityPlanSchema,
  ArtifactCompatibilityReportSchema,
} from './artifact-compatibility.js';
import { ArtifactInspectionReportSchema } from './artifact-inspection.js';
import {
  ArtifactReviewDecisionRequestSchema,
  ArtifactSubmissionDetailSchema,
  ArtifactSubmissionPageSchema,
  ArtifactSubmissionSchema,
  ArtifactUploadAcceptanceSchema,
} from './artifact-review.js';
import { AuditChainExportManifestSchema } from './audit-chain-export.js';
import {
  AuthorizedFileDiffRequestSchema,
  AuthorizedFileDiffResponseSchema,
  AuthorizedFileMutationReceiptSchema,
  CopyAuthorizedFileRequestSchema,
  CreateAuthorizedFileRequestSchema,
  DeleteAuthorizedFileRequestSchema,
  MoveAuthorizedFileRequestSchema,
  RestoreAuthorizedFileRequestSchema,
} from './authorized-file-operation.js';
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
import {
  ConsoleCommandRequestSchema,
  ConsolePageSchema,
  ProcessControlRequestSchema,
  ProcessForceKillRequestSchema,
} from './process-operation.js';
import { ReleaseManifestSchema } from './release-manifest.js';
import {
  OutboxEventSchema,
  ServerOperationPageSchema,
  ServerOperationSchema,
  ServerProcessStateSchema,
} from './server-operation.js';
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
  ['agent-credential.schema.json', AgentCredentialSchema],
  ['agent-envelope.schema.json', AgentEnvelopeSchema],
  ['agent-work-claim-response.schema.json', AgentWorkClaimResponseSchema],
  ['agent-work-lease.schema.json', AgentWorkLeaseSchema],
  ['artifact-compatibility-plan.schema.json', ArtifactCompatibilityPlanSchema],
  ['artifact-compatibility-report.schema.json', ArtifactCompatibilityReportSchema],
  ['artifact-inspection-report.schema.json', ArtifactInspectionReportSchema],
  ['artifact-review-decision-request.schema.json', ArtifactReviewDecisionRequestSchema],
  ['artifact-submission.schema.json', ArtifactSubmissionSchema],
  ['artifact-submission-detail.schema.json', ArtifactSubmissionDetailSchema],
  ['artifact-submission-page.schema.json', ArtifactSubmissionPageSchema],
  ['artifact-upload-acceptance.schema.json', ArtifactUploadAcceptanceSchema],
  ['audit-chain-export-manifest.schema.json', AuditChainExportManifestSchema],
  ['audit-event.schema.json', AuditEventSchema],
  ['authorized-file-diff-request.schema.json', AuthorizedFileDiffRequestSchema],
  ['authorized-file-diff-response.schema.json', AuthorizedFileDiffResponseSchema],
  ['authorized-file-mutation-receipt.schema.json', AuthorizedFileMutationReceiptSchema],
  ['copy-authorized-file-request.schema.json', CopyAuthorizedFileRequestSchema],
  ['create-authorized-file-request.schema.json', CreateAuthorizedFileRequestSchema],
  ['delete-authorized-file-request.schema.json', DeleteAuthorizedFileRequestSchema],
  ['move-authorized-file-request.schema.json', MoveAuthorizedFileRequestSchema],
  ['restore-authorized-file-request.schema.json', RestoreAuthorizedFileRequestSchema],
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
  ['outbox-event.schema.json', OutboxEventSchema],
  ['player-data-policy.schema.json', PlayerDataPolicySchema],
  ['player-profile.schema.json', PlayerProfileSchema],
  ['console-command-request.schema.json', ConsoleCommandRequestSchema],
  ['console-page.schema.json', ConsolePageSchema],
  ['process-control-request.schema.json', ProcessControlRequestSchema],
  ['process-force-kill-request.schema.json', ProcessForceKillRequestSchema],
  ['release-manifest.schema.json', ReleaseManifestSchema],
  ['server-operation.schema.json', ServerOperationSchema],
  ['server-operation-page.schema.json', ServerOperationPageSchema],
  ['server-process-state.schema.json', ServerProcessStateSchema],
] as const;

const schemaDirectory = new URL('./schemas/', import.meta.url);
await mkdir(schemaDirectory, { recursive: true });

await Promise.all(
  schemas.map(async ([filename, schema]) => {
    const output = `${JSON.stringify(schema, null, 2)}\n`;
    await writeFile(new URL(filename, schemaDirectory), output, 'utf8');
  }),
);
