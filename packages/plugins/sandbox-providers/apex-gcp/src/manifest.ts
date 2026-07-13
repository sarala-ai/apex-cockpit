import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.apex-gcp-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

// apex-gcp: an *apex-flavored GCP execution environment* (apex-tower §5). It
// provisions a GCE instance as a Paperclip sandbox where agent work AND `apex run`
// execute. NOT apex's internal providers/gcp (which is apex *targeting* GCP). The
// instance installs apex at boot via the run-tower AR-pull (deferred image, §4),
// authenticated by its attached service account.
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "APEX on GCP",
  description:
    "Provisions a Google Compute Engine instance as a Paperclip execution environment with the APEX CLI installed, for running APEX workflows and agent work on GCP.",
  author: "Sarala",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "apex-gcp",
      kind: "sandbox_provider",
      displayName: "APEX on GCP (Compute Engine)",
      description:
        "Creates a GCE instance (reused across a ticket's stages), installs the pinned APEX CLI at boot, and runs commands over `gcloud compute ssh`.",
      configSchema: {
        type: "object",
        required: ["projectId", "zone"],
        properties: {
          // ---- Essentials ----
          projectId: {
            type: "string",
            description: "GCP project the instance is created in (e.g. `sarala-cicd`).",
          },
          zone: {
            type: "string",
            description: "Compute Engine zone (e.g. `asia-south1-a`).",
          },
          apexVersion: {
            type: "string",
            description:
              "APEX version to install at boot, e.g. `0.4.2`. Pins the run to a known apex; leave blank to install the latest published.",
          },
          serviceAccount: {
            type: "string",
            description:
              "Email of the service account attached to the instance (its identity for GCP + the AR pull). Leave blank for the project default compute SA.",
          },
          // ---- Advanced: machine ----
          machineType: {
            type: "string",
            description: "GCE machine type.",
            default: "e2-medium",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Machine",
          },
          imageFamily: {
            type: "string",
            description: "Boot image family.",
            default: "debian-12",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Machine",
          },
          imageProject: {
            type: "string",
            description: "Project that hosts the boot image family.",
            default: "debian-cloud",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Machine",
          },
          diskSizeGb: {
            type: "number",
            description: "Boot disk size (GB).",
            default: 20,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Machine",
          },
          // ---- Advanced: apex install ----
          apexIndexUrl: {
            type: "string",
            description:
              "Python 'simple' index URL of the private AR the apex CLI is pulled from at boot.",
            default:
              "https://asia-south1-python.pkg.dev/sarala-cicd/sarala-packages/simple/",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "APEX install",
          },
          // ---- Advanced: lifecycle ----
          reuseLease: {
            type: "boolean",
            description:
              "Keep the instance running between stages of a ticket (warm workspace/state); stop it on release instead of deleting.",
            default: true,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Lifecycle",
          },
          useIap: {
            type: "boolean",
            description:
              "Tunnel SSH through IAP (no public IP required). Requires IAP + firewall setup.",
            default: false,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Lifecycle",
          },
          timeoutMs: {
            type: "number",
            description: "Per-command execution timeout (ms).",
            default: 1_800_000,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Lifecycle",
          },
        },
      },
    },
  ],
};

export default manifest;
