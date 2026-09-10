/**
 * Organization settings use-cases (SPEC.md §6 "Settings → Organization").
 * Read + update the tenant's core config (name, currency, timezone). Org
 * scoped by construction; only the SETTINGS module (OWNER) may mutate.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { SettingsError } from "@/lib/settings/errors";

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required.").max(200),
  currency: z
    .string()
    .trim()
    .min(3, "Currency must be a 3-letter code.")
    .max(3, "Currency must be a 3-letter code.")
    .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter ISO code, e.g. USD."),
  timezone: z.string().trim().min(1, "Timezone is required.").max(64),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export interface OrganizationSettings {
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

export async function getOrganizationSettings(orgId: string): Promise<OrganizationSettings> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, currency: true, timezone: true },
  });
  if (!org) {
    throw new SettingsError(404, "NOT_FOUND", "Organization not found.");
  }
  return org;
}

export async function updateOrganization(
  orgId: string,
  input: UpdateOrganizationInput,
): Promise<{ before: OrganizationSettings; after: OrganizationSettings }> {
  const before = await getOrganizationSettings(orgId);
  const after = await prisma.organization.update({
    where: { id: orgId },
    data: {
      name: input.name,
      currency: input.currency.toUpperCase(),
      timezone: input.timezone,
    },
    select: { id: true, name: true, currency: true, timezone: true },
  });
  return { before, after };
}
