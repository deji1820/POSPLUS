"use server";

import { Role } from "@prisma/client";
import { redirect } from "next/navigation";
import { z } from "zod";

import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";

const signupSchema = z.object({
  organizationName: z.string().trim().min(1, "Organization name is required").max(200),
  name: z.string().trim().min(1, "Your name is required").max(200),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export type SignupState = { ok: boolean; message?: string; fieldErrors?: Record<string, string[]> };

export async function signup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = signupSchema.safeParse({
    organizationName: formData.get("organizationName"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { organizationName, name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return { ok: false, message: "An account with this email already exists." };
  }

  const passwordHash = hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: organizationName },
    });
    const user = await tx.user.create({
      data: { email, name, passwordHash },
    });
    await tx.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role: Role.OWNER },
    });
  });

  redirect("/login?registered=1");
}
