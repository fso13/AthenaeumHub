package ru.krug.backend.shared.infrastructure.security;

/** Device binding failed; the filter converts it to the contract 401 envelope. */
public class DeviceBindingException extends RuntimeException {

    public DeviceBindingException(String message) {
        super(message, null, false, false);
    }
}
