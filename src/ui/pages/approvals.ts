/**
 * Compatibility façade for the approvals page (M4 Task 12). Since the McpCut
 * redesign the queue is one panel of the dashboard at `/`: the cards and the
 * live region live in `approval-queue.ts`, the document in `dashboard.ts`.
 * Everything the handler and the tests imported from here keeps resolving —
 * `renderApprovalsPage` IS the dashboard renderer, with the summary panels
 * appearing only when the caller supplies a `summary`.
 */
export {
  eligibleForBatch,
  toApprovalCard,
  type ApprovalCardView,
  type ApprovalsPageInput,
} from './approval-queue.js'
export { renderDashboardPage as renderApprovalsPage, type DashboardPageInput } from './dashboard.js'
