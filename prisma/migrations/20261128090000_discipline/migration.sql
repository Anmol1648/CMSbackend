-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "type_id" UUID,
    "positive" BOOLEAN NOT NULL DEFAULT false,
    "severity" TEXT NOT NULL DEFAULT 'minor',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "place_id" UUID,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "attachment_ids" UUID[],
    "status" TEXT NOT NULL DEFAULT 'open',
    "follow_up_on" DATE,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "recorded_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_students" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "section_id" UUID,
    "role" TEXT NOT NULL DEFAULT 'did',
    "points" INTEGER NOT NULL DEFAULT 0,
    "informed_how" TEXT NOT NULL DEFAULT 'none',
    "informed_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,
    "parent_reply" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "incident_students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "student_id" UUID,
    "action_id" UUID,
    "note" TEXT,
    "from_date" DATE,
    "to_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'done',
    "decided_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "answer" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_tenant_id_occurred_at_idx" ON "incidents"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_id_tenant_id_key" ON "incidents"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "incident_students_tenant_id_student_id_idx" ON "incident_students"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "incident_students_incident_id_student_id_key" ON "incident_students"("incident_id", "student_id");

-- CreateIndex
CREATE INDEX "incident_actions_tenant_id_status_idx" ON "incident_actions"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_students" ADD CONSTRAINT "incident_students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_students" ADD CONSTRAINT "incident_students_incident_id_tenant_id_fkey" FOREIGN KEY ("incident_id", "tenant_id") REFERENCES "incidents"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_incident_id_tenant_id_fkey" FOREIGN KEY ("incident_id", "tenant_id") REFERENCES "incidents"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
