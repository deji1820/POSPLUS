/**
 * PDF render entry point (SPEC.md §20, issue #32).
 * Wraps @react-pdf/renderer's renderToBuffer so generators and tests share
 * one seam (tests mock this module; the worker uses it for real).
 */
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import type { ReactElement } from "react";

export async function renderPdf(element: ReactElement<DocumentProps>): Promise<Buffer> {
  return renderToBuffer(element);
}
