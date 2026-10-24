-- CreateTable
CREATE TABLE "mess_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "meal_ids" UUID[],
    "fee" INTEGER NOT NULL DEFAULT 0,
    "monthly" INTEGER NOT NULL DEFAULT 0,
    "for_boarders" BOOLEAN NOT NULL DEFAULT false,
    "for_who" TEXT NOT NULL DEFAULT 'both',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mess_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mess_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "student_id" UUID,
    "staff_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mess_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mess_menus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "week" INTEGER NOT NULL DEFAULT 1,
    "weekday" INTEGER NOT NULL,
    "meal_id" UUID NOT NULL,
    "items" TEXT NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "mess_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mess_specials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "meal_id" UUID NOT NULL,
    "items" TEXT NOT NULL,
    "note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "mess_specials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mess_skips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "meal_id" UUID NOT NULL,
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mess_skips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mess_serves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "meal_id" UUID NOT NULL,
    "subscription_id" UUID,
    "guest_name" TEXT,
    "guests" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "pay_by" TEXT,
    "student_id" UUID,
    "staff_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "mess_serves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mess_ratings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "meal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mess_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mess_plans_id_tenant_id_key" ON "mess_plans"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "mess_subscriptions_tenant_id_status_idx" ON "mess_subscriptions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "mess_subscriptions_tenant_id_student_id_idx" ON "mess_subscriptions"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "mess_subscriptions_tenant_id_staff_id_idx" ON "mess_subscriptions"("tenant_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "mess_subscriptions_id_tenant_id_key" ON "mess_subscriptions"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "mess_menus_tenant_id_week_weekday_meal_id_key" ON "mess_menus"("tenant_id", "week", "weekday", "meal_id");

-- CreateIndex
CREATE UNIQUE INDEX "mess_specials_tenant_id_date_meal_id_key" ON "mess_specials"("tenant_id", "date", "meal_id");

-- CreateIndex
CREATE INDEX "mess_skips_tenant_id_date_idx" ON "mess_skips"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "mess_skips_subscription_id_date_meal_id_key" ON "mess_skips"("subscription_id", "date", "meal_id");

-- CreateIndex
CREATE INDEX "mess_serves_tenant_id_date_meal_id_idx" ON "mess_serves"("tenant_id", "date", "meal_id");

-- CreateIndex
CREATE INDEX "mess_serves_tenant_id_subscription_id_idx" ON "mess_serves"("tenant_id", "subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "mess_ratings_tenant_id_date_meal_id_user_id_key" ON "mess_ratings"("tenant_id", "date", "meal_id", "user_id");

-- AddForeignKey
ALTER TABLE "mess_plans" ADD CONSTRAINT "mess_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mess_subscriptions" ADD CONSTRAINT "mess_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mess_menus" ADD CONSTRAINT "mess_menus_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mess_specials" ADD CONSTRAINT "mess_specials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mess_skips" ADD CONSTRAINT "mess_skips_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mess_serves" ADD CONSTRAINT "mess_serves_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mess_ratings" ADD CONSTRAINT "mess_ratings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
