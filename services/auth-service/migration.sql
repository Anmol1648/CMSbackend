-- Safe migration logic without dropping tenants table

-- CreateTable
CREATE TABLE "widgets" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "sub_type" TEXT,
    "config" JSONB,
    "query" TEXT NOT NULL,
    "display_name" TEXT,
    "customization" JSONB,
    "range_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_on" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_widget_mapping" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "widget_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 1,
    "width" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_on" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_widget_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_widget_mapping_role_id_idx" ON "role_widget_mapping"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_widget_mapping_role_id_widget_id_key" ON "role_widget_mapping"("role_id", "widget_id");

-- AddForeignKey
ALTER TABLE "role_widget_mapping" ADD CONSTRAINT "role_widget_mapping_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_widget_mapping" ADD CONSTRAINT "role_widget_mapping_widget_id_fkey" FOREIGN KEY ("widget_id") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

