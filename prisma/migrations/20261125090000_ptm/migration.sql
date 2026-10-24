-- CreateTable
CREATE TABLE "ptms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "slot_minutes" INTEGER NOT NULL DEFAULT 10,
    "break_start" TEXT,
    "break_end" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'in_person',
    "who_sits" TEXT NOT NULL DEFAULT 'class_subject',
    "booking" BOOLEAN NOT NULL DEFAULT true,
    "section_ids" UUID[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ptms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ptm_teachers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ptm_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "room" TEXT,
    "link" TEXT,
    "away" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ptm_teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ptm_meetings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ptm_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "slot" TEXT,
    "topic_ids" UUID[],
    "parent_note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "booked_by" UUID,
    "checked_in_at" TIMESTAMPTZ(6),
    "met_at" TIMESTAMPTZ(6),
    "remark_ids" UUID[],
    "remarks" TEXT,
    "actions" TEXT,
    "follow_up_on" DATE,
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ptm_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ptms_tenant_id_date_idx" ON "ptms"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ptms_id_tenant_id_key" ON "ptms"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ptm_teachers_ptm_id_staff_id_key" ON "ptm_teachers"("ptm_id", "staff_id");

-- CreateIndex
CREATE INDEX "ptm_meetings_tenant_id_student_id_idx" ON "ptm_meetings"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "ptm_meetings_tenant_id_ptm_id_staff_id_idx" ON "ptm_meetings"("tenant_id", "ptm_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "ptm_meetings_ptm_id_staff_id_student_id_key" ON "ptm_meetings"("ptm_id", "staff_id", "student_id");

-- AddForeignKey
ALTER TABLE "ptms" ADD CONSTRAINT "ptms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ptm_teachers" ADD CONSTRAINT "ptm_teachers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ptm_teachers" ADD CONSTRAINT "ptm_teachers_ptm_id_tenant_id_fkey" FOREIGN KEY ("ptm_id", "tenant_id") REFERENCES "ptms"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ptm_meetings" ADD CONSTRAINT "ptm_meetings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ptm_meetings" ADD CONSTRAINT "ptm_meetings_ptm_id_tenant_id_fkey" FOREIGN KEY ("ptm_id", "tenant_id") REFERENCES "ptms"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
