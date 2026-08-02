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
}

export interface PermitContext {
  actorRole?: ActorRole;
  documentCount?: number;
  assignedReviewerId?: string;
  reviewerEligible?(reviewerId: string): Promise<boolean>;
}
