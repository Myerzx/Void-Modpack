import {
  ECOSYSTEM_ANALYZER_VERSION,
  EcosystemAnalysisService,
} from '@voidfall/ecosystem-analysis';

import type { WorkspaceEcosystemService } from './workspace-routes.js';

/** Thin runtime adapter; analysis decisions stay in the domain package. */
export function createWorkspaceEcosystemService(): WorkspaceEcosystemService {
  const service = new EcosystemAnalysisService();
  return {
    analyzerVersion: ECOSYSTEM_ANALYZER_VERSION,
    analyze: (input) => service.analyze(input),
  };
}
