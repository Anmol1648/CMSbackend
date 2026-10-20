-- CreateEnum
CREATE TYPE "TtSlotKind" AS ENUM ('period', 'break');

-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "tt_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tt_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tt_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "kind" "TtSlotKind" NOT NULL,
    "period_no" INTEGER,
    "label" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,

    CONSTRAINT "tt_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tt_days" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "schedule_id" UUID,

    CONSTRAINT "tt_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tt_loads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "stream_id" UUID,
    "subject_id" UUID NOT NULL,
    "per_week" INTEGER NOT NULL,
    "doubles" INTEGER NOT NULL DEFAULT 0,
    "parallel_group" TEXT,
    "room_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tt_loads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tt_teacher_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "max_per_day" INTEGER,
    "max_per_week" INTEGER,
    "unavailable" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tt_teacher_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TimetableStatus" NOT NULL DEFAULT 'draft',
    "unplaced" JSONB NOT NULL DEFAULT '[]',
    "generated_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "timetables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tt_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "timetable_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "period_no" INTEGER NOT NULL,
    "subject_id" UUID NOT NULL,
    "staff_id" UUID,
    "room_id" UUID,
    "locked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tt_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tt_substitutions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "section_id" UUID NOT NULL,
    "period_no" INTEGER NOT NULL,
    "subject_id" UUID,
    "absent_staff_id" UUID NOT NULL,
    "substitute_staff_id" UUID,
    "note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tt_substitutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tt_schedules_tenant_id_academic_year_id_idx" ON "tt_schedules"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "tt_schedules_id_tenant_id_key" ON "tt_schedules"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "tt_slots_tenant_id_schedule_id_idx" ON "tt_slots"("tenant_id", "schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "tt_days_tenant_id_academic_year_id_weekday_key" ON "tt_days"("tenant_id", "academic_year_id", "weekday");

-- CreateIndex
CREATE INDEX "tt_loads_tenant_id_academic_year_id_class_id_idx" ON "tt_loads"("tenant_id", "academic_year_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "tt_teacher_rules_tenant_id_academic_year_id_staff_id_key" ON "tt_teacher_rules"("tenant_id", "academic_year_id", "staff_id");

-- CreateIndex
CREATE INDEX "timetables_tenant_id_academic_year_id_status_idx" ON "timetables"("tenant_id", "academic_year_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "timetables_id_tenant_id_key" ON "timetables"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "tt_entries_tenant_id_timetable_id_staff_id_weekday_period_n_idx" ON "tt_entries"("tenant_id", "timetable_id", "staff_id", "weekday", "period_no");

-- CreateIndex
CREATE UNIQUE INDEX "tt_entries_timetable_id_section_id_weekday_period_no_subjec_key" ON "tt_entries"("timetable_id", "section_id", "weekday", "period_no", "subject_id");

-- CreateIndex
CREATE INDEX "tt_substitutions_tenant_id_date_idx" ON "tt_substitutions"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "tt_substitutions_tenant_id_date_section_id_period_no_absent_key" ON "tt_substitutions"("tenant_id", "date", "section_id", "period_no", "absent_staff_id");

-- AddForeignKey
ALTER TABLE "tt_schedules" ADD CONSTRAINT "tt_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_schedules" ADD CONSTRAINT "tt_schedules_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_slots" ADD CONSTRAINT "tt_slots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_slots" ADD CONSTRAINT "tt_slots_schedule_id_tenant_id_fkey" FOREIGN KEY ("schedule_id", "tenant_id") REFERENCES "tt_schedules"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_days" ADD CONSTRAINT "tt_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_days" ADD CONSTRAINT "tt_days_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_days" ADD CONSTRAINT "tt_days_schedule_id_tenant_id_fkey" FOREIGN KEY ("schedule_id", "tenant_id") REFERENCES "tt_schedules"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_class_id_tenant_id_fkey" FOREIGN KEY ("class_id", "tenant_id") REFERENCES "classes"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_stream_id_tenant_id_fkey" FOREIGN KEY ("stream_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_subject_id_tenant_id_fkey" FOREIGN KEY ("subject_id", "tenant_id") REFERENCES "subjects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_room_id_tenant_id_fkey" FOREIGN KEY ("room_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_teacher_rules" ADD CONSTRAINT "tt_teacher_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_teacher_rules" ADD CONSTRAINT "tt_teacher_rules_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_teacher_rules" ADD CONSTRAINT "tt_teacher_rules_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_timetable_id_tenant_id_fkey" FOREIGN KEY ("timetable_id", "tenant_id") REFERENCES "timetables"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_section_id_tenant_id_fkey" FOREIGN KEY ("section_id", "tenant_id") REFERENCES "sections"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_subject_id_tenant_id_fkey" FOREIGN KEY ("subject_id", "tenant_id") REFERENCES "subjects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_room_id_tenant_id_fkey" FOREIGN KEY ("room_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_substitutions" ADD CONSTRAINT "tt_substitutions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_substitutions" ADD CONSTRAINT "tt_substitutions_section_id_tenant_id_fkey" FOREIGN KEY ("section_id", "tenant_id") REFERENCES "sections"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_substitutions" ADD CONSTRAINT "tt_substitutions_subject_id_tenant_id_fkey" FOREIGN KEY ("subject_id", "tenant_id") REFERENCES "subjects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_substitutions" ADD CONSTRAINT "tt_substitutions_absent_staff_id_tenant_id_fkey" FOREIGN KEY ("absent_staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tt_substitutions" ADD CONSTRAINT "tt_substitutions_substitute_staff_id_tenant_id_fkey" FOREIGN KEY ("substitute_staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma can't express
CREATE UNIQUE INDEX "tt_schedules_tenant_year_name_key" ON "tt_schedules" ("tenant_id", "academic_year_id", lower("name"));
CREATE UNIQUE INDEX "tt_loads_class_stream_subject_key" ON "tt_loads" ("tenant_id", "academic_year_id", "class_id", COALESCE("stream_id", '00000000-0000-0000-0000-000000000000'::uuid), "subject_id");
CREATE UNIQUE INDEX "timetables_one_published_key" ON "timetables" ("tenant_id", "academic_year_id") WHERE "status" = 'published';
ALTER TABLE "tt_loads" ADD CONSTRAINT "tt_loads_per_week_check" CHECK ("per_week" BETWEEN 1 AND 60 AND "doubles" >= 0 AND "doubles" * 2 <= "per_week");
ALTER TABLE "tt_days" ADD CONSTRAINT "tt_days_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);
ALTER TABLE "tt_entries" ADD CONSTRAINT "tt_entries_slot_check" CHECK ("weekday" BETWEEN 1 AND 7 AND "period_no" >= 1);
ALTER TABLE "tt_substitutions" ADD CONSTRAINT "tt_substitutions_period_check" CHECK ("period_no" >= 1);
ALTER TABLE "tt_slots" ADD CONSTRAINT "tt_slots_time_check" CHECK ("start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" > "start_time");
ALTER TABLE "tt_slots" ADD CONSTRAINT "tt_slots_period_no_check" CHECK (("kind" = 'period') = ("period_no" IS NOT NULL));
ALTER TABLE "tt_teacher_rules" ADD CONSTRAINT "tt_teacher_rules_limits_check" CHECK (("max_per_day" IS NULL OR "max_per_day" BETWEEN 0 AND 20) AND ("max_per_week" IS NULL OR "max_per_week" BETWEEN 0 AND 100));
