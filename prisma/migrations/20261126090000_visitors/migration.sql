-- CreateTable
CREATE TABLE "visitors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "photo_file_id" UUID,
    "id_type_id" UUID,
    "id_number" TEXT,
    "address" TEXT,
    "blacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklist_reason" TEXT,
    "last_visit_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "pass_no" TEXT,
    "day" DATE NOT NULL,
    "purpose_id" UUID,
    "host_kind" TEXT NOT NULL DEFAULT 'office',
    "staff_id" UUID,
    "student_id" UUID,
    "people" INTEGER NOT NULL DEFAULT 1,
    "vehicle_no" TEXT,
    "note" TEXT,
    "photo_file_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'in',
    "in_at" TIMESTAMPTZ(6),
    "out_at" TIMESTAMPTZ(6),
    "answered_by" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "answer_note" TEXT,
    "created_by" UUID,
    "checked_out_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_people" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "relation_id" UUID,
    "mobile" TEXT,
    "photo_file_id" UUID,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "added_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pickup_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_pickups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "by_kind" TEXT NOT NULL,
    "guardian_id" UUID,
    "person_id" UUID,
    "name" TEXT NOT NULL,
    "relation" TEXT,
    "mobile" TEXT,
    "photo_file_id" UUID,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'done',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "student_pickups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visitors_tenant_id_mobile_idx" ON "visitors"("tenant_id", "mobile");

-- CreateIndex
CREATE UNIQUE INDEX "visitors_id_tenant_id_key" ON "visitors"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "visits_tenant_id_day_status_idx" ON "visits"("tenant_id", "day", "status");

-- CreateIndex
CREATE INDEX "visits_tenant_id_staff_id_idx" ON "visits"("tenant_id", "staff_id");

-- CreateIndex
CREATE INDEX "visits_tenant_id_pass_no_idx" ON "visits"("tenant_id", "pass_no");

-- CreateIndex
CREATE UNIQUE INDEX "visits_id_tenant_id_key" ON "visits"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "pickup_people_tenant_id_student_id_idx" ON "pickup_people"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "student_pickups_tenant_id_at_idx" ON "student_pickups"("tenant_id", "at");

-- CreateIndex
CREATE INDEX "student_pickups_tenant_id_student_id_idx" ON "student_pickups"("tenant_id", "student_id");

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_visitor_id_tenant_id_fkey" FOREIGN KEY ("visitor_id", "tenant_id") REFERENCES "visitors"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_people" ADD CONSTRAINT "pickup_people_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_pickups" ADD CONSTRAINT "student_pickups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
