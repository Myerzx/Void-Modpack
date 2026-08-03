import type {
  ActorRef,
  MinecraftPermissionBinding,
  ModerationAction,
  ModerationCase,
  PlayerDataCategory,
  PlayerDataPolicy,
  PlayerProfile,
} from '@voidfall/contracts';

export type PlayerGovernanceErrorCode =
  | 'invalid-options'
  | 'invalid-operation'
  | 'invalid-uuid'
  | 'invalid-alias'
  | 'invalid-timestamp'
  | 'invalid-revision'
  | 'invalid-groups'
  | 'invalid-permission-node'
  | 'invalid-provider'
  | 'invalid-provider-receipt'
  | 'invalid-moderation-transition'
  | 'profile-limit-exceeded'
  | 'alias-limit-exceeded'
  | 'binding-limit-exceeded'
  | 'case-limit-exceeded'
  | 'replay-limit-exceeded'
  | 'operation-conflict'
  | 'revision-conflict'
  | 'profile-not-found'
  | 'binding-not-found'
  | 'case-not-found'
  | 'profile-not-active'
  | 'case-not-actionable';

export class PlayerGovernanceError extends Error {
  public readonly code: PlayerGovernanceErrorCode;

  public constructor(code: PlayerGovernanceErrorCode) {
    super(`player-governance:${code}`);
    this.name = 'PlayerGovernanceError';
    this.code = code;
  }
}

export interface GovernanceRegistryOptions {
  readonly maximumRecords: number;
  readonly maximumReplays: number;
}

export interface PlayerProfileRegistryOptions extends GovernanceRegistryOptions {
  readonly maximumAliasesPerProfile: number;
}

export interface ObservePlayerAliasPlan {
  readonly operationId: string;
  readonly playerUuid: string;
  readonly expectedRevision: number | null;
  readonly alias: string;
  readonly source: PlayerProfile['aliases'][number]['source'];
  readonly serverInstanceId: string;
  readonly observedAt: string;
}

export interface ChangePlayerProfileStatusPlan {
  readonly operationId: string;
  readonly playerUuid: string;
  readonly expectedRevision: number;
  readonly status: PlayerProfile['status'];
  readonly actor: ActorRef;
  readonly reason: string;
  readonly changedAt: string;
}

export interface SetMinecraftGroupsPlan {
  readonly operationId: string;
  readonly bindingId: string;
  readonly playerUuid: string;
  readonly serverInstanceId: string;
  readonly expectedRevision: number | null;
  readonly groups: readonly string[];
  readonly requestedBy: ActorRef;
  readonly reason: string;
  readonly requestedAt: string;
}

export interface RevokeMinecraftGroupsPlan {
  readonly operationId: string;
  readonly bindingId: string;
  readonly expectedRevision: number;
  readonly requestedBy: ActorRef;
  readonly reason: string;
  readonly requestedAt: string;
}

export interface MinecraftGroupSynchronizationRequest {
  readonly operationId: string;
  readonly bindingId: string;
  readonly expectedRevision: number;
  readonly attemptedAt: string;
}

export interface MinecraftGroupProviderRequest {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly playerUuid: string;
  readonly serverInstanceId: string;
  readonly groups: readonly string[];
}

export interface MinecraftGroupProviderReceipt {
  readonly providerId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly playerUuid: string;
  readonly serverInstanceId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly attemptedAt: string;
  readonly receiptId: string;
  readonly errorCode?: string;
}

export interface MinecraftPermissionCheckRequest {
  readonly playerUuid: string;
  readonly serverInstanceId: string;
  readonly permissionNode: string;
  readonly checkedAt: string;
}

export interface MinecraftPermissionCheckReceipt extends MinecraftPermissionCheckRequest {
  readonly providerId: string;
  readonly allowed: boolean;
  readonly receiptId: string;
}

export interface MinecraftPermissionProvider {
  readonly providerId: string;
  synchronizeGroups(
    request: MinecraftGroupProviderRequest,
  ): Promise<MinecraftGroupProviderReceipt>;
  checkPermission(
    request: MinecraftPermissionCheckRequest,
  ): Promise<MinecraftPermissionCheckReceipt>;
}

export type MinecraftSynchronizationDecision =
  | {
      readonly attempted: true;
      readonly reason: 'synchronized' | 'provider-rejected';
      readonly binding: MinecraftPermissionBinding;
    }
  | {
      readonly attempted: false;
      readonly reason: 'provider-unavailable' | 'provider-failed' | 'invalid-provider-receipt';
      readonly binding: MinecraftPermissionBinding;
    };

export interface MinecraftPermissionDecision {
  readonly allowed: boolean;
  readonly reason:
    | 'allowed'
    | 'denied'
    | 'provider-unavailable'
    | 'provider-failed'
    | 'invalid-provider-receipt';
  readonly providerId?: string;
  readonly receiptId?: string;
}

export interface RequestModerationCasePlan {
  readonly operationId: string;
  readonly caseId: string;
  readonly playerUuid: string;
  readonly serverInstanceId: string;
  readonly action: ModerationAction;
  readonly reasonCode: string;
  readonly reason: string;
  readonly requestedBy: ActorRef;
  readonly requestedAt: string;
  readonly expiresAt?: string;
}

export interface ModerationExecutionRequest {
  readonly caseId: string;
  readonly caseRevision: number;
  readonly playerUuid: string;
  readonly serverInstanceId: string;
  readonly action: ModerationAction;
  readonly reasonCode: string;
  readonly reason: string;
  readonly expiresAt?: string;
}

export interface ModerationExecutionReceipt {
  readonly executorId: string;
  readonly caseId: string;
  readonly caseRevision: number;
  readonly outcome: 'succeeded' | 'failed';
  readonly attemptedAt: string;
  readonly receiptId: string;
  readonly errorCode?: string;
}

export interface ModerationExecutor {
  readonly executorId: string;
  apply(request: ModerationExecutionRequest): Promise<ModerationExecutionReceipt>;
}

export interface ExecuteModerationPlan {
  readonly operationId: string;
  readonly caseId: string;
  readonly expectedRevision: number;
  readonly attemptedAt: string;
}

export interface RevokeModerationPlan {
  readonly operationId: string;
  readonly caseId: string;
  readonly expectedRevision: number;
  readonly revokedAt: string;
  readonly actor: ActorRef;
  readonly reason: string;
}

export type ModerationExecutionDecision =
  | {
      readonly attempted: true;
      readonly reason: 'applied' | 'executor-rejected';
      readonly moderationCase: ModerationCase;
    }
  | {
      readonly attempted: false;
      readonly reason: 'executor-unavailable' | 'executor-failed' | 'invalid-executor-receipt';
      readonly moderationCase: ModerationCase;
    };

export interface PlayerDataDecisionRequest {
  readonly operation: 'collect' | 'view' | 'export';
  readonly category: PlayerDataCategory;
  readonly purposeCode: string;
  readonly evaluatedAt: string;
  readonly observedAt?: string;
  readonly retentionExpiresAt?: string;
  readonly grantedPanelPermissions?: readonly string[];
}

export interface PlayerDataDecision {
  readonly allowed: boolean;
  readonly reason:
    | 'allowed'
    | 'policy-unavailable'
    | 'policy-not-effective'
    | 'purpose-mismatch'
    | 'collection-disabled'
    | 'permission-denied'
    | 'retention-expired'
    | 'export-disabled'
    | 'invalid-record-window';
  readonly policyId?: string;
  readonly policyRevision?: number;
  readonly retentionExpiresAt?: string;
}

export type { MinecraftPermissionBinding, ModerationCase, PlayerDataPolicy, PlayerProfile };
