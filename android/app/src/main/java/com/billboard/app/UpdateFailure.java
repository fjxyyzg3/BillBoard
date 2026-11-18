package com.billboard.app;

import java.io.IOException;

final class UpdateFailure extends IOException {
    final String code;
    UpdateFailure(String code) {
        super(code);
        this.code = code;
    }
}
