import { z } from "zod";

// Initialize before client schemas so validation never probes eval under the CSP.
z.config({ jitless: true });
