ALTER TABLE `recurring_series` ADD `category` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `amount_cents` integer;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `payment_method` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `next_due_date` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `remind_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `needs_document` integer DEFAULT true NOT NULL;