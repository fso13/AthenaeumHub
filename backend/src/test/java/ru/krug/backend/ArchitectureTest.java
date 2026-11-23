package ru.krug.backend;

import java.util.Arrays;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import jakarta.persistence.Entity;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * Enforces the final B-01 layering contract:
 *   domain      -> pure Java (+ shared.error)
 *   application -> domain/application/shared, never infrastructure or api
 *   api         -> application/shared only, never domain or infrastructure
 *   cross-context links only through ports/ids/events (domain isolation).
 *
 * All rules are methods (not fields) so the ArchUnit engine reports each one in Surefire.
 */
@AnalyzeClasses(packages = "ru.krug.backend",
        importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    private static final String[] CONTEXTS = {"auth", "workspace", "chat", "message", "ops",
            "audit", "realtime", "file", "sticker", "notification", "plugin", "bot"};

    @ArchTest
    static void domainIsPureJava(JavaClasses classes) {
        noClasses()
                .that().resideInAPackage("ru.krug.backend..domain..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "ru.krug.backend..application..",
                        "ru.krug.backend..infrastructure..",
                        "ru.krug.backend..api..",
                        "org.springframework..",
                        "jakarta.persistence..",
                        "jakarta.transaction..",
                        "com.fasterxml.jackson..",
                        "org.hibernate..")
                .check(classes);
    }

    @ArchTest
    static void applicationDoesNotDependOnInfrastructureOrApi(JavaClasses classes) {
        noClasses()
                .that().resideInAPackage("ru.krug.backend..application..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "ru.krug.backend..infrastructure..",
                        "ru.krug.backend..api..")
                .check(classes);
    }

    @ArchTest
    static void apiDependsOnlyOnApplicationAndShared(JavaClasses classes) {
        noClasses()
                .that().resideInAPackage("ru.krug.backend..api..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "ru.krug.backend..domain..",
                        "ru.krug.backend..infrastructure..")
                .check(classes);
    }

    @ArchTest
    static void jpaEntitiesLiveInInfrastructurePersistence(JavaClasses classes) {
        classes()
                .that().areAnnotatedWith(Entity.class)
                .should().resideInAPackage("ru.krug.backend..infrastructure.persistence..")
                .check(classes);
    }

    /**
     * #103: HttpOnly cookie/CSRF handling is a transport concern. Application services may
     * carry an opaque refresh token, but must not depend on servlet/HTTP types.
     */
    @ArchTest
    static void applicationLayerHasNoHttpTransportTypes(JavaClasses classes) {
        noClasses()
                .that().resideInAPackage("ru.krug.backend..application..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "jakarta.servlet..",
                        "org.springframework.http..",
                        "org.springframework.web..")
                .check(classes);
    }

    @ArchTest
    static void applicationDoesNotUseJpa(JavaClasses classes) {
        noClasses()
                .that().resideInAPackage("ru.krug.backend..application..")
                .should().dependOnClassesThat().resideInAnyPackage(
                        "jakarta.persistence..",
                        "org.hibernate..")
                .check(classes);
    }

    @ArchTest
    static void apiDtosLiveInApiDto(JavaClasses classes) {
        classes()
                .that().resideInAPackage("ru.krug.backend..api..")
                .and().haveSimpleNameEndingWith("Request")
                .or().haveSimpleNameEndingWith("Response")
                .should().resideInAPackage("ru.krug.backend..api.dto..")
                .check(classes);
    }

    @ArchTest
    static void controllersLiveInApi(JavaClasses classes) {
        classes()
                .that().areAnnotatedWith(RestController.class)
                .should().resideInAPackage("ru.krug.backend..api..")
                .check(classes);
    }

    @ArchTest
    static void domainDoesNotDependOnOtherContextsDomain(JavaClasses classes) {
        for (String context : CONTEXTS) {
            String[] otherDomains = Arrays.stream(CONTEXTS)
                    .filter(other -> !other.equals(context))
                    .map(other -> "ru.krug.backend." + other + ".domain..")
                    .toArray(String[]::new);
            ArchRule rule = noClasses()
                    .that().resideInAPackage("ru.krug.backend." + context + ".domain..")
                    .should().dependOnClassesThat().resideInAnyPackage(otherDomains);
            rule.check(classes);
        }
    }

    /** E3: WS handlers/interceptors are transport adapters, never domain/application code. */
    @ArchTest
    static void websocketHandlersLiveInRealtimeInfrastructureWs(JavaClasses classes) {
        classes()
                .that().areAssignableTo(WebSocketHandler.class)
                .or().areAssignableTo(HandshakeInterceptor.class)
                .should().resideInAPackage("ru.krug.backend.realtime.infrastructure.ws..")
                .check(classes);
    }

    /** Domain/application/API must not leak Spring WebSocket transport types. */
    @ArchTest
    static void websocketTransportTypesStayInInfrastructure(JavaClasses classes) {
        noClasses()
                .that().resideInAnyPackage(
                        "ru.krug.backend..domain..",
                        "ru.krug.backend..application..",
                        "ru.krug.backend..api..")
                .should().dependOnClassesThat().resideInAnyPackage("org.springframework.web.socket..")
                .check(classes);
    }
}
