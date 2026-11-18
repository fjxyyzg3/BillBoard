package com.billboard.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import com.android.apksig.ApkVerifier;

import java.io.File;
import java.util.HashSet;
import java.util.Set;

final class UpdateApkVerifier {
    static PackageInfo installed(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        } catch (PackageManager.NameNotFoundException exception) { throw new IllegalStateException(exception); }
    }

    static void verify(Context context, File file, UpdateRelease release) throws UpdateFailure {
        try {
            UpdateTransfer.verifyBytes(file, release);
            PackageInfo current = installed(context);
            PackageInfo candidate = context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), 0);
            if (candidate == null || candidate.applicationInfo == null || current.signingInfo == null
                    || !context.getPackageName().equals(candidate.packageName)
                    || candidate.getLongVersionCode() != release.versionCode
                    || candidate.getLongVersionCode() <= current.getLongVersionCode()
                    || !release.versionName.equals(candidate.versionName)
                    || candidate.applicationInfo.minSdkVersion != release.minSdk
                    || release.minSdk > Build.VERSION.SDK_INT
                    || ((current.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0
                        && (candidate.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)) {
                throw new UpdateFailure("invalid");
            }
            ApkVerifier.Result verified = new ApkVerifier.Builder(file)
                    .setMinCheckedPlatformVersion(Build.VERSION.SDK_INT)
                    .setMaxCheckedPlatformVersion(Build.VERSION.SDK_INT).build().verify();
            if (!verified.isVerified() || verified.getSignerCertificates().isEmpty()) throw new UpdateFailure("invalid");
            Set<String> trusted = new HashSet<>();
            for (Signature signature : current.signingInfo.getApkContentsSigners()) trusted.add(UpdateTransfer.hex(signature.toByteArray()));
            Set<String> provided = new HashSet<>();
            for (java.security.cert.X509Certificate certificate : verified.getSignerCertificates()) {
                provided.add(UpdateTransfer.hex(certificate.getEncoded()));
            }
            // Key rotation needs an explicit release policy; historical keys are not accepted implicitly.
            if (trusted.isEmpty() || !trusted.equals(provided)) throw new UpdateFailure("invalid");
        } catch (Exception exception) {
            throw new UpdateFailure("invalid");
        }
    }
}
