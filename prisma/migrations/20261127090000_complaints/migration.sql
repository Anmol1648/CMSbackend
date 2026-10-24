-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "category_id" UUID,
    "subject" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'new',
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "raised_by" UUID,
    "raised_as" TEXT NOT NULL DEFAULT 'parent',
    "contact_name" TEXT,
    "contact_mobile" TEXT,
    "student_id" UUID,
    "staff_id" UUID,
    "route_id" UUID,
    "assigned_to" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "respond_by" TIMESTAMPTZ(6),
    "resolve_by" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "escalation" INTEGER NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMPTZ(6),
    "reopened" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "rating_note" TEXT,
    "attachment_ids" UUID[],
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "user_id" UUID,
    "author_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'reply',
    "from_raiser" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "attachment_ids" UUID[],
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "complaints_tenant_id_status_idx" ON "complaints"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "complaints_tenant_id_assigned_to_idx" ON "complaints"("tenant_id", "assigned_to");

-- CreateIndex
CREATE INDEX "complaints_tenant_id_raised_by_idx" ON "complaints"("tenant_id", "raised_by");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_id_tenant_id_key" ON "complaints"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_tenant_id_ticket_no_key" ON "complaints"("tenant_id", "ticket_no");

-- CreateIndex
CREATE INDEX "complaint_messages_tenant_id_complaint_id_created_at_idx" ON "complaint_messages"("tenant_id", "complaint_id", "created_at");

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_messages" ADD CONSTRAINT "complaint_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_messages" ADD CONSTRAINT "complaint_messages_complaint_id_tenant_id_fkey" FOREIGN KEY ("complaint_id", "tenant_id") REFERENCES "complaints"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
