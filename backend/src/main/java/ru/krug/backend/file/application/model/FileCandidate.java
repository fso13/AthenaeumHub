package ru.krug.backend.file.application.model;

/**
 * One preflight candidate, already parsed by the API. sha256 is optional per the contract.
 */
public record FileCandidate(String name, long size, String mime, String sha256) {
}
