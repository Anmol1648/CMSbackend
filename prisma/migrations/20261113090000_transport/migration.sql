-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type_id" UUID,
    "capacity" INTEGER NOT NULL DEFAULT 40,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "gps_device_id" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "type_id" UUID,
    "number" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "file_id" UUID,
    "notes" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_routes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "vehicle_id" UUID,
    "driver_id" UUID,
    "helper_id" UUID,
    "morning_start" TEXT NOT NULL DEFAULT '07:00',
    "afternoon_start" TEXT NOT NULL DEFAULT '14:00',
    "school_lat" DOUBLE PRECISION,
    "school_lng" DOUBLE PRECISION,
    "color" TEXT NOT NULL DEFAULT '#1A365D',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transport_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_stops" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "landmark" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "morning_time" TEXT,
    "afternoon_time" TEXT,
    "fare" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transport_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_transport" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "stop_id" UUID NOT NULL,
    "way" TEXT NOT NULL DEFAULT 'both',
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "fare" INTEGER,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "student_transport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "user_id" UUID,
    "kind" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'running',
    "source" TEXT NOT NULL DEFAULT 'phone',
    "last_lat" DOUBLE PRECISION,
    "last_lng" DOUBLE PRECISION,
    "last_speed" DOUBLE PRECISION,
    "last_at" TIMESTAMPTZ(6),
    "next_stop" INTEGER NOT NULL DEFAULT 0,
    "delay_min" INTEGER NOT NULL DEFAULT 0,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_points" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "stop_id" UUID,
    "student_id" UUID,
    "note" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "user_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_id_tenant_id_key" ON "vehicles"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_number_key" ON "vehicles"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "vehicle_documents_tenant_id_expires_on_idx" ON "vehicle_documents"("tenant_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "transport_routes_id_tenant_id_key" ON "transport_routes"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "transport_routes_tenant_id_name_key" ON "transport_routes"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "transport_stops_tenant_id_route_id_idx" ON "transport_stops"("tenant_id", "route_id");

-- CreateIndex
CREATE INDEX "student_transport_tenant_id_academic_year_id_student_id_idx" ON "student_transport"("tenant_id", "academic_year_id", "student_id");

-- CreateIndex
CREATE INDEX "student_transport_tenant_id_route_id_idx" ON "student_transport"("tenant_id", "route_id");

-- CreateIndex
CREATE INDEX "trips_tenant_id_day_status_idx" ON "trips"("tenant_id", "day", "status");

-- CreateIndex
CREATE INDEX "trips_tenant_id_route_id_day_idx" ON "trips"("tenant_id", "route_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "trips_id_tenant_id_key" ON "trips"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "trip_points_tenant_id_trip_id_at_idx" ON "trip_points"("tenant_id", "trip_id", "at");

-- CreateIndex
CREATE INDEX "trip_events_tenant_id_trip_id_at_idx" ON "trip_events"("tenant_id", "trip_id", "at");

-- CreateIndex
CREATE INDEX "trip_events_tenant_id_student_id_at_idx" ON "trip_events"("tenant_id", "student_id", "at");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicle_id_tenant_id_fkey" FOREIGN KEY ("vehicle_id", "tenant_id") REFERENCES "vehicles"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_route_id_tenant_id_fkey" FOREIGN KEY ("route_id", "tenant_id") REFERENCES "transport_routes"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_transport" ADD CONSTRAINT "student_transport_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_points" ADD CONSTRAINT "trip_points_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_points" ADD CONSTRAINT "trip_points_trip_id_tenant_id_fkey" FOREIGN KEY ("trip_id", "tenant_id") REFERENCES "trips"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_trip_id_tenant_id_fkey" FOREIGN KEY ("trip_id", "tenant_id") REFERENCES "trips"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
