package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class ScreenshotWorkerTest {
    private static final class Resource implements AutoCloseable {
        final AtomicInteger closes = new AtomicInteger();
        final CountDownLatch released = new CountDownLatch(1);
        public void close() { closes.incrementAndGet(); released.countDown(); }
        void assertReleased() throws Exception {
            assertTrue("Resource was not released", released.await(3, TimeUnit.SECONDS));
            assertEquals(1, closes.get());
        }
    }
    private static void await(CountDownLatch latch) throws Exception {
        assertTrue("Worker did not reach checkpoint", latch.await(3, TimeUnit.SECONDS));
    }

    @Test public void slowEncodingDoesNotBlockTheCallerOrReviveAnExpiredSession() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Resource resource = new Resource(); CompletableFuture<Object> result = new CompletableFuture<>();
        AtomicReference<Thread> encodingThread = new AtomicReference<>();
        try (ScreenshotWorker worker = new ScreenshotWorker()) {
            worker.submit(resource, () -> { encodingThread.set(Thread.currentThread()); entered.countDown(); await(release); return "frame"; }, result);
            await(entered);
            assertNotSame(Thread.currentThread(), encodingThread.get());
            // A heartbeat and revocation can run while native encoding is pending.
            AtomicLong clock = new AtomicLong(1);
            SessionState state = new SessionState(clock::get);
            state.start(state.instanceId, 0, UUID.randomUUID().toString(), "control", "pc", "agent", "capture", 1);
            long generation = state.generation; state.begin("capture");
            state.heartbeat(); clock.addAndGet(SessionState.LEASE_MS); state.expire();
            assertEquals("disconnected", state.phase); assertFalse(result.isDone());
            release.countDown(); assertEquals("frame", result.get(3, TimeUnit.SECONDS));
            state.finish(generation); assertEquals("disconnected", state.phase);
            resource.assertReleased();
        } finally { release.countDown(); }
    }

    @Test public void queueIsBoundedAndCancelledQueuedBuffersAreReleasedWithoutEncoding() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Resource active = new Resource(), queued = new Resource(), excess = new Resource(), replacement = new Resource();
        CompletableFuture<Object> first = new CompletableFuture<>(), second = new CompletableFuture<>(), third = new CompletableFuture<>(), fourth = new CompletableFuture<>();
        AtomicInteger unwantedEncodes = new AtomicInteger();
        try (ScreenshotWorker worker = new ScreenshotWorker()) {
            worker.submit(active, () -> { entered.countDown(); await(release); return "first"; }, first); await(entered);
            worker.submit(queued, () -> { unwantedEncodes.incrementAndGet(); return null; }, second);
            worker.submit(excess, () -> { unwantedEncodes.incrementAndGet(); return null; }, third);
            assertThrows(ExecutionException.class, () -> third.get(3, TimeUnit.SECONDS)); excess.assertReleased();
            assertTrue(second.cancel(false)); queued.assertReleased();
            worker.submit(replacement, () -> "replacement", fourth);
            release.countDown();
            assertEquals("first", first.get(3, TimeUnit.SECONDS)); assertEquals("replacement", fourth.get(3, TimeUnit.SECONDS));
            active.assertReleased(); replacement.assertReleased(); assertEquals(0, unwantedEncodes.get());
        } finally { release.countDown(); }
    }

    @Test public void closeRejectsPendingWorkButDoesNotCloseABufferStillUsedByNativeEncoding() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Resource active = new Resource(), queued = new Resource(), late = new Resource();
        CompletableFuture<Object> first = new CompletableFuture<>(), second = new CompletableFuture<>(), third = new CompletableFuture<>();
        ScreenshotWorker worker = new ScreenshotWorker();
        try {
            worker.submit(active, () -> {
                entered.countDown();
                // Bitmap/JPEG native work may not respond to Java interruption.
                while (release.getCount() > 0) { try { release.await(); } catch (InterruptedException ignored) { } }
                assertEquals(0, active.closes.get()); return "late frame";
            }, first); await(entered);
            worker.submit(queued, () -> { fail("Queued encoding must not run after close"); return null; }, second);
            worker.close();
            assertThrows(ExecutionException.class, () -> first.get(3, TimeUnit.SECONDS));
            assertThrows(ExecutionException.class, () -> second.get(3, TimeUnit.SECONDS));
            queued.assertReleased(); assertEquals(0, active.closes.get());
            worker.submit(late, () -> { fail("Closed worker must not encode"); return null; }, third);
            assertThrows(ExecutionException.class, () -> third.get(3, TimeUnit.SECONDS)); late.assertReleased();
            release.countDown(); active.assertReleased(); assertTrue(first.isCompletedExceptionally());
        } finally { release.countDown(); worker.close(); }
    }

    @Test public void encodingFailureAndAlreadyCancelledResultsReleaseTheirBuffers() throws Exception {
        Resource failed = new Resource(), cancelled = new Resource();
        CompletableFuture<Object> first = new CompletableFuture<>(), second = new CompletableFuture<>();
        try (ScreenshotWorker worker = new ScreenshotWorker()) {
            worker.submit(failed, () -> { throw new IllegalStateException("encoding failed"); }, first);
            assertThrows(ExecutionException.class, () -> first.get(3, TimeUnit.SECONDS)); failed.assertReleased();
            second.cancel(false);
            worker.submit(cancelled, () -> { fail("Cancelled frame must not encode"); return null; }, second);
            cancelled.assertReleased();
        }
    }

    @Test public void cancellingRunningEncodingDiscardsItsResultAndAllowsTheNextFrame() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Resource active = new Resource(), next = new Resource();
        CompletableFuture<Object> first = new CompletableFuture<>(), second = new CompletableFuture<>();
        try (ScreenshotWorker worker = new ScreenshotWorker()) {
            worker.submit(active, () -> { entered.countDown(); await(release); return "obsolete"; }, first); await(entered);
            assertTrue(first.cancel(false)); assertEquals(0, active.closes.get());
            worker.submit(next, () -> "fresh", second);
            release.countDown();
            assertEquals("fresh", second.get(3, TimeUnit.SECONDS));
            active.assertReleased(); next.assertReleased(); assertTrue(first.isCancelled());
        } finally { release.countDown(); }
    }
}
