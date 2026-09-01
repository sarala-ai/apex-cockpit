type OnboardingRouteCompany = {
  id: string;
  issuePrefix: string;
};

function matchesLeaf(pathname: string, leaf: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  // Top-level (`/onboarding`) or company-prefixed (`/pap/onboarding`).
  if (segments.length === 1) return segments[0]?.toLowerCase() === leaf;
  if (segments.length === 2) return segments[1]?.toLowerCase() === leaf;
  return false;
}

export function isOnboardingPath(pathname: string): boolean {
  return matchesLeaf(pathname, "onboarding");
}

/** The identity-first setup wizard — top-level `/setup` or `/{prefix}/setup`. */
export function isSetupPath(pathname: string): boolean {
  return matchesLeaf(pathname, "setup");
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
}): { initialStep: 1 | 2; companyId?: string } | null {
  const { pathname, companyPrefix, companies } = params;

  if (!isOnboardingPath(pathname)) return null;

  if (!companyPrefix) {
    return { initialStep: 1 };
  }

  const matchedCompany =
    companies.find(
      (company) =>
        company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
    ) ?? null;

  if (!matchedCompany) {
    return { initialStep: 1 };
  }

  return { initialStep: 2, companyId: matchedCompany.id };
}

/**
 * A companyless instance's entry routes funnel into the identity-first setup
 * wizard (`/setup`) — the cloud-first org→company spine, NOT the fork's original
 * `/onboarding` company-creation wizard. `/onboarding` stays reachable (a
 * re-entry point to create a company/agent), so we don't redirect when already
 * heading there; nor when already on `/setup`.
 */
export function shouldRedirectCompanylessRouteToSetup(params: {
  pathname: string;
  hasCompanies: boolean;
}): boolean {
  return (
    !params.hasCompanies &&
    !isSetupPath(params.pathname) &&
    !isOnboardingPath(params.pathname)
  );
}

/**
 * Whether the onboarding wizard is currently covering the screen — either
 * opened explicitly via the dialog context or auto-opened from the
 * /onboarding route and not yet dismissed. While this is true the route
 * launcher must not render interactive content, so it hands off fully to the
 * full-screen wizard instead of staying clickable/focusable behind it
 * (PAP-52).
 */
export function isOnboardingWizardActive(params: {
  onboardingOpen: boolean;
  routeDismissed: boolean;
}): boolean {
  return params.onboardingOpen || !params.routeDismissed;
}
