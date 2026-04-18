/** A single prop extracted from a page's *Props interface. */
export interface PropDef {
  name: string
  type: string
  optional: boolean
}

/** A page explicitly linked to a feature (stored in the feature's pages.ts). */
export interface FeaturePage {
  /** Page directory name, e.g. "LoginPage". */
  id: string
  /** Props extracted from the page's *Props interface. */
  props: PropDef[]
}

/** A feature discovered from src/features/<id>/ in the target project. */
export interface Feature {
  /** Directory name — used as the stable identifier. */
  id: string
  /** Human-readable display label (formatted from id). */
  name: string
  /** Short description of the feature, stored in summary.md. */
  summary: string
  /** Service file stems (e.g. "AuthService" for AuthService.ts). */
  services: string[]
  /** Flow stems (e.g. "AuthFlow" for AuthFlow.machine.ts + AuthFlow.actor.ts). */
  flows: string[]
  /** Pages explicitly linked to this feature (stored in pages.ts). */
  pages: FeaturePage[]
}

/** Tracks which service, flow, or page is currently selected in the left panel. */
export interface FeatureItemSelection {
  kind: 'service' | 'flow' | 'page'
  featureId: string
  itemId: string
}
