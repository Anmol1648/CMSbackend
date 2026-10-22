-- AlterTable
ALTER TABLE "holidays" ADD COLUMN     "event_id" UUID;

-- CreateTable
CREATE TABLE "notices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category_id" UUID,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publish_at" TIMESTAMPTZ(6),
    "expires_on" DATE,
    "for_everyone" BOOLEAN NOT NULL DEFAULT false,
    "for_all_staff" BOOLEAN NOT NULL DEFAULT false,
    "role_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "for_students" BOOLEAN NOT NULL DEFAULT false,
    "for_parents" BOOLEAN NOT NULL DEFAULT false,
    "class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "section_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "needs_ack" BOOLEAN NOT NULL DEFAULT false,
    "attachment_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "event_id" UUID,
    "submitted_by" UUID,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_reads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),

    CONSTRAINT "notice_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "type_id" UUID,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_time" TEXT,
    "end_time" TEXT,
    "venue" TEXT,
    "description" TEXT,
    "for_everyone" BOOLEAN NOT NULL DEFAULT false,
    "for_all_staff" BOOLEAN NOT NULL DEFAULT false,
    "role_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "for_students" BOOLEAN NOT NULL DEFAULT false,
    "for_parents" BOOLEAN NOT NULL DEFAULT false,
    "class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "section_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "holiday_for" TEXT NOT NULL DEFAULT 'none',
    "attachment_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "school_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notices_tenant_id_status_publish_at_idx" ON "notices"("tenant_id", "status", "publish_at");

-- CreateIndex
CREATE UNIQUE INDEX "notices_id_tenant_id_key" ON "notices"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "notice_reads_tenant_id_user_id_idx" ON "notice_reads"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_reads_notice_id_user_id_key" ON "notice_reads"("notice_id", "user_id");

-- CreateIndex
CREATE INDEX "school_events_tenant_id_start_date_idx" ON "school_events"("tenant_id", "start_date");

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_notice_id_tenant_id_fkey" FOREIGN KEY ("notice_id", "tenant_id") REFERENCES "notices"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
