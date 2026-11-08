import fitz
import cv2
import numpy as np


# Open PDF
pdf = fitz.open("invoice_Aaron Bergman_36258.pdf")

# Get first page
page = pdf[0]

# Render page as image
pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))

# Convert PyMuPDF image to NumPy array
img = np.frombuffer(
    pix.samples,
    dtype=np.uint8
).reshape(
    pix.height,
    pix.width,
    pix.n
)

# Handle RGB/RGBA images
if pix.n == 4:
    img = cv2.cvtColor(
        img,
        cv2.COLOR_RGBA2BGR
    )

# Convert to grayscale
gray = cv2.cvtColor(
    img,
    cv2.COLOR_BGR2GRAY
)

# Remove noise
blurred = cv2.GaussianBlur(
    gray,
    (5, 5),
    0
)

# Thresholding
threshold = cv2.threshold(
    blurred,
    150,
    255,
    cv2.THRESH_BINARY
)[1]

# Save processed image
cv2.imwrite(
    "processed_invoice.png",
    threshold
)

print("✅ Processed image saved as processed_invoice.png")

# Display images
cv2.imshow("Original", img)
cv2.imshow("Grayscale", gray)
cv2.imshow("Threshold", threshold)

cv2.waitKey(0)
cv2.destroyAllWindows()