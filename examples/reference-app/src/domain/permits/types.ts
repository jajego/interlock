export type PermitState =
  | "draft"
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "cancelled";

export interface PermitResource {
  id: string;
  tenantId: string;
  permitNumber: number;
  state: PermitState;
  version: string;
  applicantName: string;
  applicantUserId: string;
}

export type ActorRole = "applicant" | "reviewer" | "admin";
export interface PermitActor {
  id: string;
  tenantId: string;
  role: ActorRole;
}

export interface PermitContext {
  documentCount: number;
  assignedReviewerId?: string;
}
