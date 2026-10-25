-- CreateTable
CREATE TABLE "house_officials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "staff_id" UUID,
    "student_id" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "house_officials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "house_points" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "competition_id" UUID,
    "entry_id" UUID,
    "achievement_id" UUID,
    "student_id" UUID,
    "given_by" UUID,
    "given_on" DATE NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "house_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clubs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" UUID,
    "incharge_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "max_members" INTEGER,
    "meets" TEXT,
    "open_to_requests" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "club_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "requested_by" UUID,
    "request_note" TEXT,
    "grade" TEXT,
    "remark" TEXT,
    "joined_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_meetings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "club_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "present_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "photo_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "recorded_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID,
    "level_id" UUID,
    "date" DATE NOT NULL,
    "end_date" DATE,
    "venue" TEXT,
    "description" TEXT,
    "class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "kind" TEXT NOT NULL DEFAULT 'individual',
    "by_house" BOOLEAN NOT NULL DEFAULT false,
    "incharge_id" UUID,
    "club_id" UUID,
    "school_event_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "results_out" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "team_name" TEXT,
    "house_id" UUID,
    "student_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "position" INTEGER,
    "award" TEXT,
    "points" INTEGER NOT NULL DEFAULT 0,
    "remark" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category_id" UUID,
    "level_id" UUID,
    "result" TEXT,
    "organiser" TEXT,
    "date" DATE NOT NULL,
    "certificate_id" UUID,
    "points" INTEGER NOT NULL DEFAULT 0,
    "recorded_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "house_officials_tenant_id_academic_year_id_idx" ON "house_officials"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "house_points_tenant_id_academic_year_id_house_id_idx" ON "house_points"("tenant_id", "academic_year_id", "house_id");

-- CreateIndex
CREATE INDEX "house_points_tenant_id_competition_id_idx" ON "house_points"("tenant_id", "competition_id");

-- CreateIndex
CREATE UNIQUE INDEX "clubs_id_tenant_id_key" ON "clubs"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "clubs_tenant_id_name_key" ON "clubs"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "club_members_tenant_id_student_id_idx" ON "club_members"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "club_members_club_id_academic_year_id_student_id_key" ON "club_members"("club_id", "academic_year_id", "student_id");

-- CreateIndex
CREATE INDEX "club_meetings_tenant_id_club_id_date_idx" ON "club_meetings"("tenant_id", "club_id", "date");

-- CreateIndex
CREATE INDEX "competitions_tenant_id_academic_year_id_date_idx" ON "competitions"("tenant_id", "academic_year_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "competitions_id_tenant_id_key" ON "competitions"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "competition_entries_tenant_id_competition_id_idx" ON "competition_entries"("tenant_id", "competition_id");

-- CreateIndex
CREATE INDEX "achievements_tenant_id_student_id_idx" ON "achievements"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "achievements_tenant_id_academic_year_id_date_idx" ON "achievements"("tenant_id", "academic_year_id", "date");

-- AddForeignKey
ALTER TABLE "house_officials" ADD CONSTRAINT "house_officials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_points" ADD CONSTRAINT "house_points_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_club_id_tenant_id_fkey" FOREIGN KEY ("club_id", "tenant_id") REFERENCES "clubs"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_meetings" ADD CONSTRAINT "club_meetings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_meetings" ADD CONSTRAINT "club_meetings_club_id_tenant_id_fkey" FOREIGN KEY ("club_id", "tenant_id") REFERENCES "clubs"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_entries" ADD CONSTRAINT "competition_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_entries" ADD CONSTRAINT "competition_entries_competition_id_tenant_id_fkey" FOREIGN KEY ("competition_id", "tenant_id") REFERENCES "competitions"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

