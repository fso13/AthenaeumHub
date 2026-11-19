# Krug backend: reproducible multi-stage build.
# Build context: ../backend (not the repository root).
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

# Dependency layer is cached independently of source changes. Retry transient
# Maven Central failures; a fresh GitHub runner occasionally returns a 404 for
# a POM that exists on the next attempt.
COPY pom.xml .
RUN for attempt in 1 2 3; do \
      mvn -B -DskipTests \
        -Dmaven.wagon.http.retryHandler.count=5 \
        -Dmaven.wagon.http.retryHandler.requestSentEnabled=true \
        dependency:go-offline && exit 0; \
      echo "dependency:go-offline failed (attempt ${attempt}/3); retrying"; \
      sleep 10; \
    done; exit 1

COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre-jammy AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system krug \
    && useradd --system --gid krug --home-dir /app --shell /usr/sbin/nologin krug

WORKDIR /app
COPY --from=build /build/target/krug-backend-*.jar /app/app.jar
RUN chown -R krug:krug /app
USER krug

ENV TZ=UTC \
    JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"

EXPOSE 8081
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
