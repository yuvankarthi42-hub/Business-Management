// Service jobs (repairs, laundry, tailoring…): an item the shop takes in, the stages it goes through, and its bill at
// delivery. Shared by the API (backend/src/modules/serviceJobs.ts) and the app, so both use the same stage lists.
import type { Business, PaymentMethod } from './types'

export type JobStage =
  | 'received' | 'checking' | 'approval' | 'parts' | 'repairing' | 'ready' | 'delivered' | 'cancelled' | 'returned'
  | 'washing' | 'ironing' | 'cutting' | 'stitching' | 'trial' | 'in_progress'

export const JOB_STAGE_LABEL: Record<JobStage, string> = {
  received: 'Received', checking: 'Checking', approval: 'Waiting for approval', parts: 'Waiting for parts', repairing: 'Repairing',
  ready: 'Ready', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned (not done)',
  washing: 'Washing', ironing: 'Ironing', cutting: 'Cutting', stitching: 'Stitching', trial: 'Trial', in_progress: 'In progress',
}

/** Stages that end a job: it leaves the board (delivered is reached only by delivering it). */
export const CLOSED_STAGES: JobStage[] = ['delivered', 'cancelled', 'returned']

type Shop = Pick<Business, 'category' | 'subType'>
const repairLike = (s: string) => /repair|mobile|phone|electronic|computer|laptop|watch|garage|vehicle|bike|mechanic|workshop/i.test(s)
const laundry = (s: string) => /laundry|dry ?clean|wash|iron/i.test(s)
const tailoring = (s: string) => /tailor|alteration|stitch|boutique/i.test(s)

/** The stages a job of this shop goes through, in order (delivered is always last). */
export function jobStagesFor(b: Shop): JobStage[] {
  const s = b.subType ?? ''
  if (laundry(s)) return ['received', 'washing', 'ironing', 'ready', 'delivered']
  if (tailoring(s)) return ['received', 'cutting', 'stitching', 'trial', 'ready', 'delivered']
  if (repairLike(s)) return ['received', 'parts', 'repairing', 'ready', 'delivered']
  return ['received', 'in_progress', 'ready', 'delivered']
}

/** Shops the module is offered to (Settings → Modules): service shops and repair / electronics sellers. Off until the owner turns it on. */
export const serviceJobsShownFor = (b: Shop) => b.category === 'service' || (b.category === 'retail' && repairLike(b.subType ?? ''))

/** A job card on the board (only what the card shows). */
export interface JobCard {
  id: string
  number: string
  stage: JobStage
  stageAt: string
  item: string
  brandModel: string
  customerName: string
  customerPhone: string
  problem: string
  promisedAt: string | null
  technicianId: string | null
  estimate: number | null
  advance: number
  version: number
}
/** A job with everything the details screen shows. */
export interface ServiceJob extends JobCard {
  branchId: string
  customerId: string | null
  orderId: string | null
  serial: string
  colour: string
  accessories: string
  conditionNote: string
  closeReason: string
  deliveredAt: string | null
  createdAt: string
  createdBy: string
  events: { from: JobStage | null; to: JobStage; note: string; at: string; by: string }[]
  /** The bill (after delivery). */
  invoiceNumber: string | null
  total: number | null
}

export interface JobInput {
  customerId: string
  item: string
  brandModel?: string
  serial?: string
  colour?: string
  problem: string
  accessories?: string
  conditionNote?: string
  estimate?: number | null
  promisedAt?: string | null
  technicianId?: string | null
  advance?: { amount: number; method: Exclude<PaymentMethod, 'credit' | 'credit_note'>; reference?: string } | null
}
