import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import { Slot } from "radix-ui";
import { cn } from "../../lib/utils";

/** shadcn/ui Radix Attachment API adapted to the app's local CSS and controls. */
export function Attachment({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment" role="group" className={cn("cy-attachment", className)} {...props} />;
}

export function AttachmentMedia({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment-media" className={cn("cy-attachment__media", className)} {...props} />;
}

export function AttachmentContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment-content" className={cn("cy-attachment__content", className)} {...props} />;
}

export function AttachmentTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="attachment-title" className={cn("cy-attachment__title", className)} {...props} />;
}

export function AttachmentDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p data-slot="attachment-description" className={cn("cy-attachment__description", className)} {...props} />;
}

export function AttachmentActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment-actions" className={cn("cy-attachment__actions", className)} {...props} />;
}

export const AttachmentTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }>(
  ({ asChild, className, type = "button", ...props }, ref) => {
    const Component = asChild ? Slot.Slot : "button";
    return <Component ref={ref} type={type} className={cn("cy-attachment__trigger", className)} {...props} />;
  },
);
AttachmentTrigger.displayName = "AttachmentTrigger";

export const AttachmentAction = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }>(
  ({ asChild, className, type = "button", ...props }, ref) => {
    const Component = asChild ? Slot.Slot : "button";
    return <Component ref={ref} type={type} className={cn("cy-attachment__action", className)} {...props} />;
  },
);
AttachmentAction.displayName = "AttachmentAction";
