package ru.krug.backend.auth.application.model;

import java.util.List;

public record KeyClaimView(List<PrekeyBundleView> bundles,
                           List<UnavailableDeviceView> unavailable) {

    public KeyClaimView {
        bundles = bundles == null ? List.of() : List.copyOf(bundles);
        unavailable = unavailable == null ? List.of() : List.copyOf(unavailable);
    }
}
