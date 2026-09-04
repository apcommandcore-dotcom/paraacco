import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center border px-2 py-0.5 text-xs font-mono tracking-wide", {
  variants: {
    variant: {
      default: "border-border bg-muted text-foreground",
      outline: "border-border bg-transparent text-foreground",
      warning: "border-warning/40 bg-warning/10 text-warning",
      destructive: "border-destructive/40 bg-destructive/10 text-destructive",
      success: "border-border bg-foreground text-background",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
