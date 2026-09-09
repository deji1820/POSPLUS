"use server";

import { AuthError } from "next-auth";

import { signIn } from "@/lib/auth";

export type LoginState = { ok: boolean; message?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { ok: false, message: "Enter your email and password." };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/dashboard",
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AuthError) {
      // Deliberately vague: do not reveal whether the email exists (SPEC.md §18).
      return { ok: false, message: "Invalid email or password." };
    }
    throw error; // NextResponse redirect from signIn must propagate
  }
}
