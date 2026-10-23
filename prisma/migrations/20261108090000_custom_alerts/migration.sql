-- AlterTable
ALTER TABLE "custom_alerts" ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "summary_body" TEXT NOT NULL DEFAULT '{{list}}',
ADD COLUMN     "summary_subject" TEXT NOT NULL DEFAULT '{{alert}}: {{count}}',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'messages';
