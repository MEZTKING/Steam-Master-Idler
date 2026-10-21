// Starts the bundled Node.js runtime (libnode from nodejs-mobile) and sends its output to logcat.
// Called once per app process from NodeRunner.java. Based on nodejs-mobile's own Android glue.

#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

static const char *TAG = "SteamMasterIdler-node";
static int pipe_stdout[2];
static int pipe_stderr[2];

static void *forward(void *arg) {
    int fd = *static_cast<int *>(arg);
    int priority = fd == pipe_stderr[0] ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;   // logcat adds its own newline
        buf[n] = 0;
        __android_log_write(priority, TAG, buf);
    }
    return nullptr;
}

static void redirect_output_to_logcat() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_stdout);
    pipe(pipe_stderr);
    dup2(pipe_stdout[1], STDOUT_FILENO);
    dup2(pipe_stderr[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, forward, &pipe_stdout[0]);
    pthread_create(&t2, nullptr, forward, &pipe_stderr[0]);
    pthread_detach(t1);
    pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_meztking_steammasteridler_NodeRunner_startNodeWithArguments(JNIEnv *env, jclass, jobjectArray arguments) {
    // libuv requires all of argv to be in one contiguous block of memory
    jsize argc = env->GetArrayLength(arguments);
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
    }
    char *buffer = static_cast<char *>(calloc(total, 1));
    char **argv = static_cast<char **>(calloc(argc + 1, sizeof(char *)));
    char *pos = buffer;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(c);
        memcpy(pos, c, len);
        argv[i] = pos;
        pos += len + 1;
        env->ReleaseStringUTFChars(s, c);
    }

    redirect_output_to_logcat();
    return node::Start(argc, argv);   // runs until Node.js exits
}
