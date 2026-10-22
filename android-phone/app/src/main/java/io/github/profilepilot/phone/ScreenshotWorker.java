package io.github.profilepilot.phone;

import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Owns at most one encoding and one queued buffer; overload never runs on the caller. */
final class ScreenshotWorker implements AutoCloseable {
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), work -> new Thread(work, "phone-screenshot-encoder"));
    private final Set<Job> jobs = ConcurrentHashMap.newKeySet();
    private volatile boolean closed;

    void submit(AutoCloseable resource, Callable<Object> encode, CompletableFuture<Object> result) {
        Job job = new Job(resource, encode, result);
        jobs.add(job);
        result.whenComplete((value, error) -> { if (error != null) job.discard(); });
        if (closed || result.isDone()) {
            job.fail("截图服务已停止"); return;
        }
        try { executor.execute(job); }
        catch (RejectedExecutionException rejected) { job.fail(closed ? "截图服务已停止" : "截图处理队列已满，请稍后重新获取画面"); }
    }

    private final class Job implements Runnable {
        final AutoCloseable resource;
        final Callable<Object> encode;
        final CompletableFuture<Object> result;
        final AtomicBoolean claimed = new AtomicBoolean();
        Job(AutoCloseable resource, Callable<Object> encode, CompletableFuture<Object> result) {
            this.resource = resource; this.encode = encode; this.result = result;
        }
        public void run() {
            if (!claimed.compareAndSet(false, true)) return;
            try {
                if (closed || result.isDone()) { result.completeExceptionally(new IllegalStateException("截图服务已停止")); return; }
                Object value = encode.call();
                if (closed) result.completeExceptionally(new IllegalStateException("截图服务已停止"));
                else result.complete(value);
            } catch (Throwable error) { result.completeExceptionally(error); }
            finally { release(); }
        }
        void fail(String message) {
            result.completeExceptionally(new IllegalStateException(message));
            discard();
        }
        void discard() {
            // A running encoder owns its buffer until its finally block. Never
            // close a HardwareBuffer underneath native bitmap/compression work.
            if (claimed.compareAndSet(false, true)) { executor.remove(this); release(); }
        }
        void release() {
            try { resource.close(); }
            catch (Exception error) { result.completeExceptionally(error); }
            finally { jobs.remove(this); }
        }
    }

    @Override public void close() {
        closed = true;
        executor.shutdownNow();
        for (Job job : jobs) job.fail("截图服务已停止");
    }
}
