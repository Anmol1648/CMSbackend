# The report service (JasperReports). Runs on x86 and ARM (OCI Ampere) alike.
#   docker build -t school-erp-jasper jasper-service
#   docker run -d --name jasper --network <the backend's network> -e JASPER_TOKEN=… school-erp-jasper
# Keep it off the internet: only the backend should reach it (port 8090 inside the Docker network).
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:17-jre
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home jasper
WORKDIR /app
COPY --from=build /src/target/jasper-service.jar /app/
COPY --from=build /src/target/lib /app/lib
USER jasper
ENV HOST=0.0.0.0 PORT=8090 JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -XX:MaxRAMPercentage=75"
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8090"]
CMD ["java", "-cp", "/app/jasper-service.jar:/app/lib/*", "school.reports.Main"]
